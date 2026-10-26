import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CustomToolAPI } from '@oh-my-pi/pi-coding-agent';
import {
  EvolutionEngine,
  KeyedScheduler,
  ParetoArbiter,
  inspectPatch,
} from '../../packages/dwfx-core/src/index.ts';
import type {
  CandidateSolution,
  EvaluationOutcome,
} from '../../packages/dwfx-core/src/index.ts';
import { RsiStore } from '../../src/journal/rsi-store.ts';
import type { RsiTaskRecord } from '../../src/journal/rsi-store.ts';

export const MAX_PATCH_BYTES = 256 * 1024;
export const MAX_CHANGED_FILES = 20;

export interface EvolutionBeginInput {
  taskId?: string;
  objective: string;
  skillName?: string;
  skillReused?: boolean;
  stagingToolPath?: string;
}

export interface EvolutionRecordInput {
  runId: string;
  candidateId: string;
  diffPatch: string;
  /** SHA-256 of the exact UTF-8 diffPatch. */
  patchHash: string;
  experience?: string;
  requestCount?: number;
  tokenCount?: number;
}

export interface EvolutionAction {
  state: 'awaiting_candidate' | 'waiting' | 'completed' | 'failed' | 'escalated' | 'rejected';
  runId: string;
  candidateId?: string;
  actorKey?: string;
  role?: 'smol';
  taskPrompt?: string;
  diffPatch?: string;
  patchHash?: string;
  reason?: string;
  champion?: {
    id: string;
    patchHash: string;
    changedFiles: number;
    changedLines: number;
    durationMs: number;
  };
  frontier?: string[];
  applied?: boolean;
  /** True when this record() reused a cached terminal outcome for an identical patch hash. */
  cached?: boolean;
}

export interface EvolutionEvaluationContext {
  cwd: string;
  baseline: string;
  candidateId: string;
  /**
   * Gate target for this evaluation. Crossover candidates whose parents both
   * passed the full gate run `test` only (typecheck fast-track); everything
   * else runs the complete `all` gate.
   */
  gateTarget?: 'all' | 'test';
}

export type EvolutionEvaluator = (
  context: EvolutionEvaluationContext,
  diffPatch: string,
  signal?: AbortSignal,
) => Promise<EvaluationOutcome>;

interface EvolutionRun {
  task: RsiTaskRecord;
  baseline: string;
  engine: EvolutionEngine;
  appended?: 'debug' | 'crossover';
  experience?: string;
  /** Candidate ids evaluated through the typecheck-skipping fast track. */
  fastTrackedCandidates?: Set<string>;
}

export interface EvolutionControllerOptions {
  cwd: string;
  dbPath?: string;
  store?: RsiStore;
  evaluator?: EvolutionEvaluator;
  applyChampion?: boolean;
  gateTimeoutMs?: number;
  /**
   * INV-2 evaluation concurrency. Defaults to 1 (strict serial FIFO, required
   * on 2 vCPU hosts); hosts with more cores may raise it, also via the
   * RSI_EVAL_CONCURRENCY environment variable.
   */
  evaluationConcurrency?: number;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** Runs one child process with bounded captured output and cooperative cancellation.
 *
 * The child is spawned detached as its own process group so a timeout or abort
 * can SIGTERM — then SIGKILL after a grace period — the entire tree, including
 * grandchildren spawned by shell stages (tsc, node --test). Without the group
 * kill, a timed-out gate leaves orphan stages burning CPU past the deadline.
 */
export function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number; input?: string },
): Promise<ProcessResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ProcessResult>();
  const start = Date.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  let escalate: ReturnType<typeof setTimeout> | undefined;

  const killGroup = (): void => {
    const signalChild = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group already exited; the close event settles the result.
      }
    };
    signalChild('SIGTERM');
    escalate = setTimeout(() => signalChild('SIGKILL'), 5_000);
  };

  const finish = (code: number) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (escalate !== undefined) clearTimeout(escalate);
    options.signal?.removeEventListener('abort', onAbort);
    resolve({ code, stdout, stderr, durationMs: Date.now() - start, timedOut });
  };
  const onAbort = () => {
    killGroup();
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, options.timeoutMs ?? 120_000);

  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8').slice(0, 1024 * 1024 - stdout.length);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 1024 * 1024) stderr += chunk.toString('utf8').slice(0, 1024 * 1024 - stderr.length);
  });
  child.stdin.on('error', () => {
    // The child exit code carries a closed-stdin failure.
  });
  child.once('error', (error) => {
    clearTimeout(timeout);
    if (escalate !== undefined) clearTimeout(escalate);
    options.signal?.removeEventListener('abort', onAbort);
    reject(error);
  });
  child.once('close', (code) => finish(code ?? 1));
  child.stdin.end(options.input);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  return promise;
}

/** Serializes all candidate gates globally and all operations for one repository FIFO. */
export class EvolutionController {
  public readonly actorKey: string;
  private readonly cwd: string;
  private readonly store: RsiStore;
  private readonly ownsStore: boolean;
  private readonly evaluator: EvolutionEvaluator;
  private readonly applyChampion: boolean;
  private readonly scheduler: KeyedScheduler;
  private readonly evaluationConcurrency: number;
  private readonly runs = new Map<string, EvolutionRun>();
  private closed = false;

  constructor(options: EvolutionControllerOptions) {
    this.cwd = path.resolve(options.cwd);
    this.actorKey = `repo:${this.cwd}`;
    this.store = options.store ?? RsiStore.open(options.dbPath ?? path.join(this.cwd, '.omp/rsi.db'));
    this.ownsStore = options.store === undefined;
    this.applyChampion = options.applyChampion ?? true;
    this.evaluationConcurrency = resolveEvaluationConcurrency(options.evaluationConcurrency);
    this.scheduler = new KeyedScheduler(this.evaluationConcurrency, { attempts: 1 });
    this.evaluator = options.evaluator ?? ((context, diffPatch, signal) =>
      evaluateCandidateInSandbox(context, diffPatch, {
        signal,
        timeoutMs: options.gateTimeoutMs ?? 120_000,
        gateTarget: context.gateTarget,
      }));
  }

  get activeEvaluations(): number {
    return this.scheduler.running;
  }

  async begin(input: EvolutionBeginInput): Promise<EvolutionAction> {
    this.assertOpen();
    if (!input.objective.trim()) return { state: 'rejected', runId: input.taskId ?? '', reason: 'objective is required' };
    const runId = input.taskId ?? `rsi-${randomUUID()}`;
    if (this.runs.has(runId)) return { state: 'rejected', runId, reason: `run ${runId} is already active` };
    const baseline = await detectBaseline(this.cwd);
    const task = this.store.createTask({
      id: runId,
      cwd: this.cwd,
      objective: input.objective,
      autonomous: true,
      skillName: input.skillName,
      skillReused: input.skillReused,
      stagingToolPath: input.stagingToolPath,
    });
    const engine = new EvolutionEngine({ runId, maxCandidates: 2, maxDebugRounds: 2 });
    const run: EvolutionRun = { task, baseline, engine };
    this.runs.set(runId, run);
    for (let index = 0; index < 2; index += 1) {
      const candidate = engine.registerCandidate('draft', '', [], {
        taskId: runId,
        baseline,
        requestCount: 1,
      });
      this.persistCandidate(runId, candidate);
    }
    return this.actionForCandidate(run, engine.listCandidates()[0]);
  }

  async record(input: EvolutionRecordInput, signal?: AbortSignal): Promise<EvolutionAction> {
    this.assertOpen();
    const run = this.runs.get(input.runId);
    if (!run) return { state: 'rejected', runId: input.runId, reason: `run ${input.runId} is not active` };
    const candidate = run.engine.getCandidate(input.candidateId);
    if (!candidate || candidate.status !== 'pending') {
      return { state: 'rejected', runId: input.runId, candidateId: input.candidateId, reason: 'candidate is not pending' };
    }
    const bytes = Buffer.byteLength(input.diffPatch, 'utf8');
    if (bytes === 0 || bytes > MAX_PATCH_BYTES) {
      return {
        state: 'rejected',
        runId: input.runId,
        candidateId: input.candidateId,
        reason: `patch must contain 1..${MAX_PATCH_BYTES} UTF-8 bytes; received ${bytes}`,
      };
    }
    const patch = inspectPatch(input.diffPatch);
    if (patch.changedFiles < 1 || patch.changedFiles > MAX_CHANGED_FILES) {
      return {
        state: 'rejected',
        runId: input.runId,
        candidateId: input.candidateId,
        reason: `patch must modify 1..${MAX_CHANGED_FILES} files; received ${patch.changedFiles}`,
      };
    }
    const expectedHash = createHash('sha256').update(input.diffPatch).digest('hex');
    if (input.patchHash !== expectedHash) {
      return {
        state: 'rejected',
        runId: input.runId,
        candidateId: input.candidateId,
        reason: `patch hash mismatch: expected ${expectedHash}`,
      };
    }

    candidate.status = 'evaluating';
    candidate.diffPatch = input.diffPatch;
    candidate.patchHash = expectedHash;
    candidate.changedFilePaths = patch.changedFilePaths;
    candidate.metrics.changedFiles = patch.changedFiles;
    candidate.metrics.changedLines = patch.changedLines;
    const storedId = `${input.runId}:${input.candidateId}`;
    this.store.updatePatch(storedId, input.diffPatch, expectedHash);
    this.store.setCandidateEvaluating(storedId);
    if (input.experience?.trim()) run.experience = input.experience.trim();

    // KeyedScheduler serializes per actor key: at the INV-2 default (1) the
    // repo key gives one strict global FIFO; above it, per-candidate keys let
    // the global cap admit parallel gates while each key stays serial.
    const evaluationKey = this.evaluationConcurrency > 1
      ? `${this.actorKey}:eval:${input.candidateId}`
      : this.actorKey;
    return this.scheduler.enqueue(evaluationKey, {
      isProviderError: () => false,
      work: async () => {
        let outcome: EvaluationOutcome;
        let cachedHit = false;
        const cached = this.store.findEvaluationByPatchHash(input.patchHash);
        if (cached) {
          // INV-1: an identical patch hash already reached a terminal outcome;
          // reuse it instead of paying the sandbox gate again.
          cachedHit = true;
          outcome = {
            exitCode: cached.exitCode,
            durationMs: cached.durationMs,
            testPassRatio: cached.testPassRatio,
            stderr: cached.status === 'passed'
              ? undefined
              : `CACHED_OUTCOME: an identical patch hash already failed with exitCode=${cached.exitCode}`,
          };
        } else {
          const gateTarget = candidate.operator === 'crossover' ? 'test' : 'all';
          if (gateTarget === 'test') {
            (run.fastTrackedCandidates ??= new Set<string>()).add(candidate.id);
          }
          try {
            outcome = await this.evaluator(
              { cwd: this.cwd, baseline: run.baseline, candidateId: candidate.id, gateTarget },
              input.diffPatch,
              signal,
            );
          } catch (error) {
            outcome = {
              exitCode: 1,
              durationMs: 0,
              testPassRatio: 0,
              stderr: `UNKNOWN_STATE_SUSPENSION: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
        outcome.requestCount = input.requestCount ?? candidate.metrics.requestCount;
        outcome.tokenCount = input.tokenCount ?? candidate.metrics.tokenCount;
        const evaluated = run.engine.reportEvaluation(candidate.id, outcome);
        this.store.recordEvaluation(storedId, {
          normalizedErrorHash: evaluated.candidate.normalizedErrorHash,
          exitCode: evaluated.candidate.metrics.exitCode,
          durationMs: evaluated.candidate.metrics.durationMs,
          testPassRatio: evaluated.candidate.metrics.testPassRatio,
          status: evaluated.candidate.status as 'passed' | 'failed' | 'deadlocked',
        });
        const decorate = (action: EvolutionAction): EvolutionAction => {
          if (cachedHit) action.cached = true;
          return action;
        };
        if (outcome.stderr?.startsWith('UNKNOWN_STATE_SUSPENSION:')) {
          this.store.settleTask(run.task.id, 'failed');
          return decorate({
            state: 'escalated',
            runId: run.task.id,
            candidateId: candidate.id,
            reason: outcome.stderr,
          });
        }
        if (evaluated.requiresEscalation) {
          this.store.settleTask(run.task.id, 'failed');
          return decorate({
            state: 'escalated',
            runId: run.task.id,
            candidateId: candidate.id,
            reason: evaluated.escalationReason,
          });
        }
        const action = await this.nextAction(run);
        return decorate(action);
      },
    });
  }

  async drain(): Promise<void> {
    await this.scheduler.drain();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsStore) this.store.close();
  }

  private nextAction(run: EvolutionRun): EvolutionAction | Promise<EvolutionAction> {
    const candidates = run.engine.listCandidates();
    if (candidates.some((candidate) => candidate.status === 'evaluating')) {
      return { state: 'waiting', runId: run.task.id, reason: 'another candidate is queued or evaluating' };
    }
    const pending = candidates.find((candidate) => candidate.status === 'pending');
    if (pending) return this.actionForCandidate(run, pending);

    if (!run.appended && candidates.length < 3) {
      const passed = candidates.filter((candidate) => candidate.status === 'passed');
      if (passed.length >= 2) {
        const parentFiles = new Set(passed[0].changedFilePaths);
        const disjoint = passed[1].changedFilePaths.every((file) => !parentFiles.has(file));
        if (disjoint) {
          const crossover = run.engine.crossover(passed[0].id, passed[1].id);
          run.appended = 'crossover';
          this.persistCandidate(run.task.id, crossover);
          return this.actionForCandidate(run, crossover);
        }
      }
      const failed = candidates.find((candidate) => candidate.status === 'failed');
      if (failed) {
        const debug = run.engine.registerCandidate('debug', '', [failed.id], {
          taskId: run.task.id,
          baseline: run.baseline,
          requestCount: 1,
        });
        run.appended = 'debug';
        this.persistCandidate(run.task.id, debug);
        return this.actionForCandidate(run, debug);
      }
    }

    const arbitration = new ParetoArbiter().arbitrate(candidates);
    if (!arbitration.champion) {
      this.store.settleTask(run.task.id, 'failed', { experience: run.experience });
      return { state: 'failed', runId: run.task.id, reason: 'no candidate passed the hard gate' };
    }
    const champion = arbitration.champion;
    if (this.applyChampion) {
      return this.mergeChampion(run, champion, arbitration.frontier);
    }
    this.store.settleTask(run.task.id, 'succeeded', {
      championId: `${run.task.id}:${champion.id}`,
      experience: run.experience,
    });
    return this.completedAction(run, champion, arbitration.frontier, false);
  }

  private async mergeChampion(
    run: EvolutionRun,
    champion: CandidateSolution,
    frontier: CandidateSolution[],
  ): Promise<EvolutionAction> {
    const checked = await runProcess('git', ['apply', '--check', '--whitespace=nowarn', '-'], {
      cwd: this.cwd,
      timeoutMs: 10_000,
      input: champion.diffPatch,
    });
    if (checked.code !== 0) {
      this.store.settleTask(run.task.id, 'failed', { experience: run.experience });
      return {
        state: 'failed',
        runId: run.task.id,
        candidateId: champion.id,
        reason: `champion no longer applies cleanly: ${checked.stderr}`,
      };
    }
    const applied = await runProcess('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: this.cwd,
      timeoutMs: 10_000,
      input: champion.diffPatch,
    });
    if (applied.code !== 0) {
      this.store.settleTask(run.task.id, 'failed', { experience: run.experience });
      return {
        state: 'escalated',
        runId: run.task.id,
        candidateId: champion.id,
        reason: `UNKNOWN_STATE_SUSPENSION: git apply failed after a successful check: ${applied.stderr}`,
      };
    }
    if (run.fastTrackedCandidates?.has(champion.id)) {
      // The champion skipped its sandbox typecheck; re-establish the global
      // "merged champions always typecheck" guarantee on the real workspace.
      const typecheck = await runProcess(
        process.execPath,
        [path.join(this.cwd, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.json'],
        { cwd: this.cwd, timeoutMs: 60_000 },
      );
      if (typecheck.code !== 0) {
        await runProcess('git', ['apply', '-R', '--whitespace=nowarn', '-'], {
          cwd: this.cwd,
          timeoutMs: 10_000,
          input: champion.diffPatch,
        });
        this.store.settleTask(run.task.id, 'failed', { experience: run.experience });
        return {
          state: 'escalated',
          runId: run.task.id,
          candidateId: champion.id,
          reason: `FAST_TRACK_TYPECHECK_FAILED: champion typecheck failed after merge and was rolled back: ${typecheck.stderr.slice(0, 400)}`,
        };
      }
    }
    this.store.settleTask(run.task.id, 'succeeded', {
      championId: `${run.task.id}:${champion.id}`,
      experience: run.experience,
    });
    return this.completedAction(run, champion, frontier, true);
  }

  private completedAction(
    run: EvolutionRun,
    champion: CandidateSolution,
    frontier: CandidateSolution[],
    applied: boolean,
  ): EvolutionAction {
    return {
      state: 'completed',
      runId: run.task.id,
      candidateId: champion.id,
      champion: {
        id: champion.id,
        patchHash: champion.patchHash,
        changedFiles: champion.metrics.changedFiles,
        changedLines: champion.metrics.changedLines,
        durationMs: champion.metrics.durationMs,
      },
      frontier: frontier.map((candidate) => candidate.id),
      applied,
    };
  }

  private actionForCandidate(run: EvolutionRun, candidate: CandidateSolution): EvolutionAction {
    const hash = createHash('sha256').update(candidate.diffPatch).digest('hex');
    const base = {
      state: 'awaiting_candidate' as const,
      runId: run.task.id,
      candidateId: candidate.id,
      actorKey: this.actorKey,
      role: 'smol' as const,
    };
    if (candidate.operator === 'crossover') {
      return {
        ...base,
        diffPatch: candidate.diffPatch,
        patchHash: hash,
        taskPrompt: `Re-evaluate the supplied crossover patch with evolution_record. It remains undeliverable until the full gate passes. Run ${run.task.id}, candidate ${candidate.id}.`,
      };
    }
    const repair = candidate.operator === 'debug'
      ? ` Repair parent ${candidate.parentIds[0]}; normalized error ${run.engine.getCandidate(candidate.parentIds[0])?.normalizedErrorHash ?? 'unknown'}.`
      : '';
    return {
      ...base,
      taskPrompt: `Act as a low-resource draft agent. Objective: ${run.task.objective}. Produce one unified git diff against baseline ${run.baseline}; at most ${MAX_CHANGED_FILES} files and ${MAX_PATCH_BYTES} UTF-8 bytes. Do not install dependencies. Submit it with evolution_record using runId ${run.task.id}, candidateId ${candidate.id}, and the SHA-256 patch hash.${repair}`,
    };
  }

  private persistCandidate(runId: string, candidate: CandidateSolution): void {
    this.store.createCandidate(runId, {
      id: `${runId}:${candidate.id}`,
      operator: candidate.operator,
      parentIds: candidate.parentIds,
      diffPatch: candidate.diffPatch,
      patchHash: candidate.diffPatch ? createHash('sha256').update(candidate.diffPatch).digest('hex') : undefined,
      normalizedErrorHash: candidate.normalizedErrorHash,
      exitCode: candidate.metrics.exitCode,
      durationMs: candidate.metrics.durationMs,
      testPassRatio: candidate.metrics.testPassRatio,
      status: candidate.status,
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('evolution controller is closed');
  }
}

/** Evaluates a patch in a temporary worktree, or a controlled source copy outside Git. */
export async function evaluateCandidateInSandbox(
  context: EvolutionEvaluationContext,
  diffPatch: string,
  options: { signal?: AbortSignal; timeoutMs?: number; gateTarget?: 'all' | 'test' } = {},
): Promise<EvaluationOutcome> {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rsi-cand-'));
  const sandbox = path.join(tempRoot, 'repo');
  let worktree = false;
  try {
    const git = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: context.cwd,
      signal: options.signal,
      timeoutMs: 10_000,
    });
    if (git.code === 0 && git.stdout.trim() === 'true') {
      const added = await runProcess('git', ['worktree', 'add', '--detach', sandbox, context.baseline], {
        cwd: context.cwd,
        signal: options.signal,
        timeoutMs: 30_000,
      });
      if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
      worktree = true;
      await overlayWorkingChanges(context.cwd, sandbox, options.signal);
    } else {
      await copyControlledSources(context.cwd, sandbox, diffPatch);
    }

    if (fs.existsSync(path.join(context.cwd, 'node_modules'))) {
      await fs.promises.symlink(path.join(context.cwd, 'node_modules'), path.join(sandbox, 'node_modules'), 'dir');
    }
    const patchPath = path.join(tempRoot, 'candidate.patch');
    await fs.promises.writeFile(patchPath, diffPatch, 'utf8');
    const applied = await runProcess('git', ['apply', '--whitespace=nowarn', patchPath], {
      cwd: sandbox,
      signal: options.signal,
      timeoutMs: 10_000,
    });
    if (applied.code !== 0) {
      return {
        exitCode: applied.code,
        durationMs: applied.durationMs,
        testPassRatio: 0,
        stderr: applied.stderr || 'git apply failed',
      };
    }

    const gatePath = path.join(context.cwd, 'scripts/evolution-gate.mjs');
    const gate = await runProcess(process.execPath, [gatePath, `--target=${options.gateTarget ?? 'all'}`], {
      cwd: sandbox,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    if (gate.timedOut) throw new Error(`evaluation gate timed out after ${options.timeoutMs ?? 120_000} ms`);
    let report: { exitCode?: number; durationMs?: number; passRatio?: number };
    try {
      report = JSON.parse(gate.stdout) as typeof report;
    } catch {
      throw new Error(`evaluation gate returned invalid JSON: ${gate.stdout.slice(0, 500)} ${gate.stderr.slice(0, 500)}`);
    }
    return {
      exitCode: gate.code === 0 ? 0 : (report.exitCode ?? gate.code),
      durationMs: report.durationMs ?? gate.durationMs,
      testPassRatio: report.passRatio ?? 0,
      stderr: gate.code === 0 ? undefined : gate.stderr || `evaluation gate failed with ${gate.code}`,
    };
  } finally {
    try {
      if (worktree) {
        const removed = await runProcess('git', ['worktree', 'remove', '--force', sandbox], {
          cwd: context.cwd,
          timeoutMs: 30_000,
        });
        if (removed.code !== 0) throw new Error(`git worktree cleanup failed: ${removed.stderr}`);
      }
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function detectBaseline(cwd: string): Promise<string> {
  const result = await runProcess('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 10_000 });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : 'working-tree';
}

async function overlayWorkingChanges(cwd: string, sandbox: string, signal?: AbortSignal): Promise<void> {
  const [modified, untracked] = await Promise.all([
    runProcess('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd, signal, timeoutMs: 10_000 }),
    runProcess('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, signal, timeoutMs: 10_000 }),
  ]);
  if (modified.code !== 0 || untracked.code !== 0) throw new Error('unable to enumerate working-tree changes');
  const files = [...new Set([...modified.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))];
  for (const relative of files) {
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`unsafe working-tree path: ${relative}`);
    }
  }
  await Promise.all(files.map((relative) => {
    const source = path.resolve(cwd, relative);
    const destination = path.resolve(sandbox, relative);
    if (fs.existsSync(source)) {
      return fs.promises.mkdir(path.dirname(destination), { recursive: true })
        .then(() => fs.promises.copyFile(source, destination));
    }
    return fs.promises.rm(destination, { force: true });
  }));
}

/** INV-2 default is strict serial (1); only explicit opt-ins raise it. */
function resolveEvaluationConcurrency(explicit?: number): number {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 1) {
      throw new Error(`evaluationConcurrency must be a positive integer, got ${explicit}`);
    }
    return explicit;
  }
  const fromEnv = Number(process.env.RSI_EVAL_CONCURRENCY ?? '');
  return Number.isInteger(fromEnv) && fromEnv >= 1 ? fromEnv : 1;
}

async function copyControlledSources(cwd: string, sandbox: string, diffPatch: string): Promise<void> {
  await fs.promises.mkdir(sandbox, { recursive: true });
  const entries = [
    'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json',
    'src', 'assets', 'packages', 'scripts', 'test', 'stubs', '.omp',
  ];
  for (const entry of entries) {
    const source = path.join(cwd, entry);
    if (!fs.existsSync(source)) continue;
    await fs.promises.cp(source, path.join(sandbox, entry), {
      recursive: true,
      force: true,
      filter: (sourcePath) => {
        const relative = path.relative(cwd, sourcePath);
        return !relative.split(path.sep).includes('node_modules') &&
          !relative.split(path.sep).includes('.git') &&
          !/^\.omp[\\/]rsi\.db(?:-|$)/.test(relative);
      },
    });
  }
  for (const relative of inspectPatch(diffPatch).changedFilePaths) {
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`unsafe candidate path: ${relative}`);
    }
    const source = path.resolve(cwd, relative);
    if (!fs.existsSync(source)) continue;
    const destination = path.resolve(sandbox, relative);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.copyFile(source, destination);
  }
}

function toolText(action: EvolutionAction): string {
  if (action.taskPrompt) return action.taskPrompt;
  if (action.reason) return action.reason;
  return action.state === 'completed'
    ? `Champion ${action.champion?.id}; applied=${action.applied}`
    : `Evolution run ${action.runId}: ${action.state}`;
}

export default function evolutionTools(pi: CustomToolAPI) {
  const controller = new EvolutionController({ cwd: pi.cwd });
  return [
    {
      name: 'evolution_begin',
      label: 'Begin Evolution Run',
      description: 'Initialize two bounded draft candidates and return the first smol-agent task prompt.',
      parameters: pi.zod.object({
        taskId: pi.zod.string().optional(),
        objective: pi.zod.string(),
        skillName: pi.zod.string().optional(),
        skillReused: pi.zod.boolean().optional(),
        stagingToolPath: pi.zod.string().optional(),
      }),
      approval: 'exec',
      async execute(_toolCallId: string, params: EvolutionBeginInput) {
        const action = await controller.begin(params);
        return { content: [{ type: 'text', text: toolText(action) }], details: action };
      },
      onSession(event: { reason?: string }) {
        if (event.reason === 'shutdown') controller.close();
      },
    },
    {
      name: 'evolution_record',
      label: 'Evaluate Evolution Candidate',
      description: 'Verify a patch hash, evaluate serially in an isolated sandbox, and advance or arbitrate the run.',
      parameters: pi.zod.object({
        runId: pi.zod.string(),
        candidateId: pi.zod.string(),
        diffPatch: pi.zod.string(),
        patchHash: pi.zod.string(),
        experience: pi.zod.string().optional(),
        requestCount: pi.zod.number().optional(),
        tokenCount: pi.zod.number().optional(),
      }),
      approval: 'exec',
      async execute(_toolCallId: string, params: EvolutionRecordInput, _onUpdate: unknown, _ctx: unknown, signal?: AbortSignal) {
        const action = await controller.record(params, signal);
        return { content: [{ type: 'text', text: toolText(action) }], details: action };
      },
    },
  ];
}
