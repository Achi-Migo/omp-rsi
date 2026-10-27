import { DatabaseSync } from 'node:sqlite';
export type RsiTaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type RsiCandidateStatus = 'pending' | 'evaluating' | 'passed' | 'failed' | 'deadlocked';
export type RsiOperator = 'draft' | 'improve' | 'debug' | 'crossover';
export interface RsiTaskInput {
    id: string;
    cwd: string;
    objective: string;
    autonomous?: boolean;
    skillName?: string;
    skillReused?: boolean;
    stagingToolPath?: string;
}
export interface RsiTaskRecord {
    id: string;
    cwd: string;
    objective: string;
    status: RsiTaskStatus;
    autonomous: boolean;
    skillName?: string;
    skillReused: boolean;
    skillPromoted: boolean;
    stagingToolPath?: string;
    promotedToolPath?: string;
    experience?: string;
    championId?: string;
    nextCandidateSeq: number;
    timeCreated: number;
    timeUpdated: number;
    timeCompleted?: number;
}
export interface RsiCandidateInput {
    id: string;
    operator: RsiOperator;
    parentIds: string[];
    diffPatch: string;
    patchHash?: string;
    normalizedErrorHash?: string;
    exitCode?: number;
    durationMs?: number;
    testPassRatio?: number;
    status?: RsiCandidateStatus;
}
export interface RsiCandidateRecord {
    id: string;
    taskId: string;
    sequence: number;
    operator: RsiOperator;
    parentIds: string[];
    diffPatch: string;
    patchHash?: string;
    normalizedErrorHash?: string;
    exitCode: number;
    durationMs: number;
    testPassRatio: number;
    status: RsiCandidateStatus;
    timeCreated: number;
    timeUpdated: number;
}
export interface CachedEvaluation {
    status: 'passed' | 'failed';
    exitCode: number;
    durationMs: number;
    testPassRatio: number;
}
export interface RsiEvaluation {
    normalizedErrorHash?: string;
    exitCode: number;
    durationMs: number;
    testPassRatio: number;
    status: Exclude<RsiCandidateStatus, 'pending' | 'evaluating'>;
}
export interface RsiMetrics {
    taskCount: number;
    autonomousRate: number | null;
    averageTimeToGreenMs: number | null;
    toolGenerationSuccessRate: number | null;
    skillReuseRate: number | null;
    candidateCount: number;
    passedCandidateCount: number;
}
export interface RsiStoreOptions {
    now?: () => number;
    retainedRuns?: number;
}
/** One SQLite connection, precompiled statements, and transaction-scoped sequences. */
export declare class RsiStore {
    private readonly db;
    private readonly now;
    private readonly retainedRuns;
    private readonly statements;
    constructor(db: DatabaseSync, options?: RsiStoreOptions);
    static open(dbPath: string, options?: RsiStoreOptions): RsiStore;
    close(): void;
    createTask(input: RsiTaskInput): RsiTaskRecord;
    getTask(id: string): RsiTaskRecord | undefined;
    createCandidate(taskId: string, input: RsiCandidateInput): RsiCandidateRecord;
    getCandidate(id: string): RsiCandidateRecord | undefined;
    listCandidates(taskId: string): RsiCandidateRecord[];
    updatePatch(candidateId: string, diffPatch: string, patchHash?: string): void;
    /** INV-1: the newest terminal evaluation of an identical patch, if any. */
    findEvaluationByPatchHash(patchHash: string): CachedEvaluation | undefined;
    setCandidateEvaluating(candidateId: string): void;
    recordEvaluation(candidateId: string, evaluation: RsiEvaluation): RsiCandidateRecord;
    settleTask(taskId: string, status: Exclude<RsiTaskStatus, 'running'>, details?: {
        championId?: string;
        experience?: string;
    }): RsiTaskRecord;
    listVerifiedTasks(): RsiTaskRecord[];
    markToolPromoted(taskId: string, promotedToolPath: string): boolean;
    /** Atomically claims at least three distinct, verified task records for one skill. */
    claimSkillPromotion(skillName: string): RsiTaskRecord[] | undefined;
    releaseSkillPromotion(skillName: string): void;
    metrics(): RsiMetrics;
    private requireTask;
    private requireCandidate;
    private prune;
    private transaction;
}
