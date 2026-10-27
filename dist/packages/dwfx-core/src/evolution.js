/**
 * OpenRSI Evolution Engine for omp host.
 *
 * Implements the 4 atomic evolution operators (Draft, Improve, Debug, Crossover),
 * deterministic deadlock detection, and ledger-backed sequence monotonicity.
 */
import { fnv1a32 } from "./json.js";
/** Derives file and line costs from a unified diff without loading repository files. */
export function inspectPatch(diffPatch) {
    const files = new Set();
    let changedLines = 0;
    for (const line of diffPatch.split('\n')) {
        const gitHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
        if (gitHeader) {
            files.add(gitHeader[2].replace(/^"|"$/g, ''));
        }
        else if (line.startsWith('+++ b/')) {
            files.add(line.slice(6).replace(/^"|"$/g, ''));
        }
        if ((line.startsWith('+') && !line.startsWith('+++')) ||
            (line.startsWith('-') && !line.startsWith('---'))) {
            changedLines += 1;
        }
    }
    const changedFilePaths = [...files].sort();
    return { changedFilePaths, changedFiles: changedFilePaths.length, changedLines };
}
export class ParetoArbiter {
    static passesHardGate(candidate) {
        return candidate.metrics.exitCode === 0 && candidate.metrics.testPassRatio === 1;
    }
    /** Minimizes files, lines, requests, tokens, and duration; request count does not break final ties. */
    arbitrate(candidates) {
        const eligible = candidates.filter((candidate) => ParetoArbiter.passesHardGate(candidate));
        const frontier = eligible.filter((candidate, index) => eligible.every((other, otherIndex) => index === otherIndex || !this.dominates(other, candidate)));
        frontier.sort((a, b) => this.compareChampionOrder(a, b));
        return { eligible, frontier, champion: frontier[0] };
    }
    paretoFront(candidates) {
        return this.arbitrate(candidates).frontier;
    }
    selectChampion(candidates) {
        return this.arbitrate(candidates).champion;
    }
    dominates(a, b) {
        const av = this.costVector(a);
        const bv = this.costVector(b);
        let strictlyBetter = false;
        for (let index = 0; index < av.length; index += 1) {
            if (av[index] > bv[index])
                return false;
            if (av[index] < bv[index])
                strictlyBetter = true;
        }
        return strictlyBetter;
    }
    compareChampionOrder(a, b) {
        const av = this.costVector(a);
        const bv = this.costVector(b);
        for (const index of [0, 1, 3, 4]) {
            if (av[index] !== bv[index])
                return av[index] - bv[index];
        }
        const aHash = a.patchHash || fnv1a32(a.diffPatch);
        const bHash = b.patchHash || fnv1a32(b.diffPatch);
        return aHash === bHash ? a.id.localeCompare(b.id) : aHash.localeCompare(bHash);
    }
    costVector(candidate) {
        const patch = inspectPatch(candidate.diffPatch);
        return [
            candidate.metrics.changedFiles ?? patch.changedFiles,
            candidate.metrics.changedLines ?? patch.changedLines,
            candidate.metrics.requestCount ?? 0,
            candidate.metrics.tokenCount ?? 0,
            candidate.metrics.durationMs,
        ];
    }
}
export class EvolutionEngine {
    runId;
    maxCandidates;
    maxDebugRounds;
    ledger;
    errorAttemptCounts = new Map();
    candidates = new Map();
    candidateSeqMap = new Map();
    candidateCounter = 0;
    constructor(options = {}) {
        this.runId = options.runId ?? 'default';
        this.maxCandidates = options.maxCandidates ?? 2;
        this.maxDebugRounds = options.maxDebugRounds ?? 2;
        this.ledger = options.ledger;
        if (this.maxCandidates < 1 || this.maxDebugRounds < 1) {
            throw new Error('maxCandidates and maxDebugRounds must be at least 1');
        }
    }
    /** Normalizes volatile error details and computes a stable 32-bit FNV-1a signature. */
    normalizeError(rawError) {
        const cleaned = rawError
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '')
            .replace(/\/tmp\/[a-zA-Z0-9_-]+/g, '/tmp/<temp>')
            .replace(/:\d+:\d+/g, ':<loc>')
            .replace(/at\s+.*\(.*:<loc>\)/g, 'at <stack>')
            .replace(/\s+/g, ' ')
            .trim();
        return fnv1a32(cleaned);
    }
    registerCandidate(operator, diffPatch, parentIds = [], registration = {}) {
        this.candidateCounter += 1;
        const candidateId = `cand-${operator}-${this.candidateCounter}`;
        const taskId = registration.taskId ?? this.runId;
        if (this.ledger) {
            const actorKey = `openrsi:${taskId}:${operator}:${candidateId}`;
            const seq = this.ledger.begin(actorKey, candidateId);
            this.candidateSeqMap.set(candidateId, seq);
        }
        const patch = inspectPatch(diffPatch);
        const changedFilePaths = [...new Set(registration.changedFiles ?? patch.changedFilePaths)].sort();
        const candidate = {
            id: candidateId,
            taskId,
            baseline: registration.baseline ?? 'working-tree',
            operator,
            parentIds,
            diffPatch,
            patchHash: fnv1a32(diffPatch),
            changedFilePaths,
            metrics: {
                exitCode: -1,
                durationMs: 0,
                testPassRatio: 0,
                changedFiles: changedFilePaths.length,
                changedLines: patch.changedLines,
                requestCount: registration.requestCount ?? 0,
                tokenCount: registration.tokenCount ?? 0,
            },
            status: 'pending',
        };
        this.candidates.set(candidateId, candidate);
        return candidate;
    }
    reportEvaluation(candidateId, outcome) {
        const candidate = this.candidates.get(candidateId);
        if (!candidate) {
            throw new Error(`Candidate with id ${candidateId} not found`);
        }
        let requiresEscalation = false;
        let escalationReason;
        candidate.metrics = {
            exitCode: outcome.exitCode,
            durationMs: outcome.durationMs,
            testPassRatio: outcome.testPassRatio,
            changedFiles: outcome.changedFiles ?? candidate.metrics.changedFiles,
            changedLines: outcome.changedLines ?? candidate.metrics.changedLines,
            requestCount: outcome.requestCount ?? candidate.metrics.requestCount,
            tokenCount: outcome.tokenCount ?? candidate.metrics.tokenCount,
        };
        if (ParetoArbiter.passesHardGate(candidate)) {
            candidate.status = 'passed';
            candidate.normalizedErrorHash = undefined;
            for (const key of this.errorAttemptCounts.keys()) {
                if (key.startsWith(`${candidate.taskId}:`))
                    this.errorAttemptCounts.delete(key);
            }
            this.settleLedger(candidate.id, 'completed');
        }
        else {
            candidate.status = 'failed';
            const rawError = outcome.stderr || `exitCode=${outcome.exitCode}`;
            const errorHash = this.normalizeError(rawError);
            candidate.normalizedErrorHash = errorHash;
            const key = `${candidate.taskId}:${errorHash}`;
            const attempts = (this.errorAttemptCounts.get(key) ?? 0) + 1;
            this.errorAttemptCounts.set(key, attempts);
            if (attempts >= this.maxDebugRounds) {
                candidate.status = 'deadlocked';
                requiresEscalation = true;
                escalationReason = `REPAIR_LOOP_DEADLOCK: Error signature ${errorHash} repeated ${attempts} times without resolution.`;
            }
            this.settleLedger(candidate.id, 'failed');
        }
        return { candidate, requiresEscalation, escalationReason };
    }
    /**
     * Creates a pending merged candidate. It becomes deliverable only after reportEvaluation
     * reruns the hard gate; concatenation itself never marks a crossover as passed.
     */
    crossover(candidateIdA, candidateIdB) {
        const a = this.candidates.get(candidateIdA);
        const b = this.candidates.get(candidateIdB);
        if (!a || !b) {
            throw new Error(`Cannot perform crossover: candidates ${candidateIdA} or ${candidateIdB} missing.`);
        }
        if (a.taskId !== b.taskId || a.baseline !== b.baseline) {
            throw new Error('Cannot perform crossover: parents must share the same task baseline.');
        }
        if (a.status !== 'passed' || b.status !== 'passed' ||
            !ParetoArbiter.passesHardGate(a) || !ParetoArbiter.passesHardGate(b)) {
            throw new Error('Cannot perform crossover: both parents must pass the full test gate.');
        }
        const filesA = new Set(a.changedFilePaths);
        if (b.changedFilePaths.some((file) => filesA.has(file))) {
            throw new Error('Cannot perform crossover: parent patches modify overlapping files.');
        }
        const mergedPatch = [a.diffPatch.trimEnd(), b.diffPatch.trimStart()].filter(Boolean).join('\n');
        return this.registerCandidate('crossover', mergedPatch, [a.id, b.id], {
            taskId: a.taskId,
            baseline: a.baseline,
        });
    }
    getCandidate(id) {
        return this.candidates.get(id);
    }
    listCandidates() {
        return [...this.candidates.values()];
    }
    getErrorAttempts(errorHash, taskId = this.runId) {
        return this.errorAttemptCounts.get(`${taskId}:${errorHash}`) ?? 0;
    }
    settleLedger(candidateId, outcome) {
        if (!this.ledger)
            return;
        const seq = this.candidateSeqMap.get(candidateId);
        if (seq !== undefined)
            this.ledger.end(seq, outcome);
    }
}
