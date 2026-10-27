/**
 * dwfx-core - INV-3: 写侧只追加与读侧单遍流式投影 (OnePassProjection)
 *
 * 契约保证：
 * 1. 写侧只追加 (Append-Only Stream)：事件序列全局严格连续递增无断裂
 * 2. 读侧单遍内存聚合：一次遍历无损重构 RunView 状态
 * 3. 展示帽保真：节点超过 maxNodes 时，截取前 maxNodes 条并注入 nodesUnlisted: true，不损物理事实
 */
export declare const DEFAULT_MAX_NODES = 2000;
export interface StreamEvent {
    readonly sequence: number;
    readonly type: string;
    readonly payload?: Record<string, unknown>;
    readonly timestamp: number;
}
export interface ProjectedNodeView {
    readonly siteId: string;
    readonly ordinal: number;
    readonly kind: string;
    status: 'running' | 'completed' | 'failed';
    actorSeq?: number;
    result?: unknown;
    error?: unknown;
    timeCreated: number;
    timeSettled?: number;
}
export interface ProjectedRunView {
    runId: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    totalEvents: number;
    nodes: ProjectedNodeView[];
    nodesUnlisted?: boolean;
    totalNodesCount: number;
    startedAt: number;
    settledAt?: number;
}
/**
 * 内存只追加流式写入器
 */
export declare class MemoryJournalWriter {
    private currentSequence;
    private readonly events;
    private readonly onAppend?;
    constructor(options?: {
        onAppend?: (event: StreamEvent) => void;
    });
    /**
     * 追加写入一条新事件。sequence 自动从 1 开始单调自增。
     */
    append(type: string, payload?: Record<string, unknown>): StreamEvent;
    get length(): number;
    get lastSequence(): number;
    getEvents(): readonly StreamEvent[];
}
/**
 * 单遍流式投影器：在内存中单遍扫描事件流，构建 ProjectedRunView 聚合状态
 * @param events 异步或同步迭代器
 * @param maxNodes 读侧展示帽，默认 2000
 */
export declare function projectStream(events: Iterable<StreamEvent> | AsyncIterable<StreamEvent>, maxNodes?: number): Promise<ProjectedRunView>;
