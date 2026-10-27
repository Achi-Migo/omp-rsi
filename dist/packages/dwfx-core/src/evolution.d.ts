/**
 * OpenRSI Evolution Engine for omp host.
 *
 * Implements the 4 atomic evolution operators (Draft, Improve, Debug, Crossover),
 * deterministic deadlock detection, and ledger-backed sequence monotonicity.
 */
import type { Ledger } from './ledger.ts';
export type OperatorKind = 'draft' | 'improve' | 'debug' | 'crossover';
export type CandidateStatus = 'pending' | 'evaluating' | 'passed' | 'failed' | 'deadlocked';
export interface EvolutionCycleOptions {
    /** Task/run identity used to isolate repair-loop counters. */
    runId?: string;
    ledger?: Ledger;
    /** Default number of independent drafts; host controllers may append one repair or crossover. */
    maxCandidates?: number;
    /** Identical normalized errors escalate on this attempt. */
    maxDebugRounds?: number;
}
export interface CandidateMetrics {
    exitCode: number;
    durationMs: number;
    testPassRatio: number;
    changedFiles: number;
    changedLines: number;
    requestCount: number;
    tokenCount: number;
}
export interface CandidateSolution {
    id: string;
    taskId: string;
    baseline: string;
    operator: OperatorKind;
    parentIds: string[];
    diffPatch: string;
    patchHash: string;
    changedFilePaths: string[];
    normalizedErrorHash?: string;
    metrics: CandidateMetrics;
    status: CandidateStatus;
}
export interface CandidateRegistration {
    taskId?: string;
    baseline?: string;
    changedFiles?: string[];
    requestCount?: number;
    tokenCount?: number;
}
export interface EvaluationOutcome {
    exitCode: number;
    durationMs: number;
    testPassRatio: number;
    stderr?: string;
    changedFiles?: number;
    changedLines?: number;
    requestCount?: number;
    tokenCount?: number;
}
export interface EvaluationResult {
    candidate: CandidateSolution;
    requiresEscalation: boolean;
    escalationReason?: string;
}
export interface PatchSummary {
    changedFilePaths: string[];
    changedFiles: number;
    changedLines: number;
}
export interface ParetoResult {
    eligible: CandidateSolution[];
    frontier: CandidateSolution[];
    champion?: CandidateSolution;
}
/** Derives file and line costs from a unified diff without loading repository files. */
export declare function inspectPatch(diffPatch: string): PatchSummary;
export declare class ParetoArbiter {
    static passesHardGate(candidate: CandidateSolution): boolean;
    /** Minimizes files, lines, requests, tokens, and duration; request count does not break final ties. */
    arbitrate(candidates: readonly CandidateSolution[]): ParetoResult;
    paretoFront(candidates: readonly CandidateSolution[]): CandidateSolution[];
    selectChampion(candidates: readonly CandidateSolution[]): CandidateSolution | undefined;
    private dominates;
    private compareChampionOrder;
    private costVector;
}
export declare class EvolutionEngine {
    readonly runId: string;
    readonly maxCandidates: number;
    private readonly maxDebugRounds;
    private readonly ledger?;
    private readonly errorAttemptCounts;
    private readonly candidates;
    private readonly candidateSeqMap;
    private candidateCounter;
    constructor(options?: EvolutionCycleOptions);
    /** Normalizes volatile error details and computes a stable 32-bit FNV-1a signature. */
    normalizeError(rawError: string): string;
    registerCandidate(operator: OperatorKind, diffPatch: string, parentIds?: string[], registration?: CandidateRegistration): CandidateSolution;
    reportEvaluation(candidateId: string, outcome: EvaluationOutcome): EvaluationResult;
    /**
     * Creates a pending merged candidate. It becomes deliverable only after reportEvaluation
     * reruns the hard gate; concatenation itself never marks a crossover as passed.
     */
    crossover(candidateIdA: string, candidateIdB: string): CandidateSolution;
    getCandidate(id: string): CandidateSolution | undefined;
    listCandidates(): CandidateSolution[];
    getErrorAttempts(errorHash: string, taskId?: string): number;
    private settleLedger;
}
