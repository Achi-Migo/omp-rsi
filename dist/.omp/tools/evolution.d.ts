import type { CustomToolAPI } from '@oh-my-pi/pi-coding-agent';
import type { EvaluationOutcome } from '../../packages/dwfx-core/src/index.ts';
import { RsiStore } from '../../src/journal/rsi-store.ts';
export declare const MAX_PATCH_BYTES: number;
export declare const MAX_CHANGED_FILES = 20;
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
export type EvolutionEvaluator = (context: EvolutionEvaluationContext, diffPatch: string, signal?: AbortSignal) => Promise<EvaluationOutcome>;
export interface EvolutionControllerOptions {
    cwd?: string;
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
export declare function runProcess(command: string, args: string[], options: {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    input?: string;
}): Promise<ProcessResult>;
/** Serializes all candidate gates globally and all operations for one repository FIFO. */
export declare class EvolutionController {
    readonly actorKey: string;
    private readonly cwd;
    private readonly store;
    private readonly ownsStore;
    private readonly evaluator;
    private readonly applyChampion;
    private readonly scheduler;
    private readonly evaluationConcurrency;
    private readonly runs;
    private closed;
    constructor(options: EvolutionControllerOptions);
    get activeEvaluations(): number;
    begin(input: EvolutionBeginInput): Promise<EvolutionAction>;
    record(input: EvolutionRecordInput, signal?: AbortSignal): Promise<EvolutionAction>;
    drain(): Promise<void>;
    close(): void;
    private nextAction;
    private mergeChampion;
    private completedAction;
    private actionForCandidate;
    private persistCandidate;
    private assertOpen;
}
/** Evaluates a patch in a temporary worktree, or a controlled source copy outside Git. */
export declare function evaluateCandidateInSandbox(context: EvolutionEvaluationContext, diffPatch: string, options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    gateTarget?: 'all' | 'test';
}): Promise<EvaluationOutcome>;
export declare function toolText(action: EvolutionAction): string;
export default function evolutionTools(pi: CustomToolAPI): ({
    name: string;
    label: string;
    description: string;
    parameters: import("@oh-my-pi/pi-coding-agent").OmpSchema;
    approval: string;
    execute(_toolCallId: string, params: EvolutionBeginInput): Promise<{
        content: {
            type: string;
            text: string;
        }[];
        details: EvolutionAction;
    }>;
    onSession(event: {
        reason?: string;
    }): void;
} | {
    name: string;
    label: string;
    description: string;
    parameters: import("@oh-my-pi/pi-coding-agent").OmpSchema;
    approval: string;
    execute(_toolCallId: string, params: EvolutionRecordInput, _onUpdate: unknown, _ctx: unknown, signal?: AbortSignal): Promise<{
        content: {
            type: string;
            text: string;
        }[];
        details: EvolutionAction;
    }>;
    onSession?: undefined;
})[];
export {};
