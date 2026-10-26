/**
 * dwfx-core - INV-3: 写侧只追加与读侧单遍流式投影 (OnePassProjection)
 * 
 * 契约保证：
 * 1. 写侧只追加 (Append-Only Stream)：事件序列全局严格连续递增无断裂
 * 2. 读侧单遍内存聚合：一次遍历无损重构 RunView 状态
 * 3. 展示帽保真：节点超过 maxNodes 时，截取前 maxNodes 条并注入 nodesUnlisted: true，不损物理事实
 */

export const DEFAULT_MAX_NODES = 2000;

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
export class MemoryJournalWriter {
  private currentSequence = 0;
  private readonly events: StreamEvent[] = [];
  private readonly onAppend?: (event: StreamEvent) => void;

  constructor(options: { onAppend?: (event: StreamEvent) => void } = {}) {
    this.onAppend = options.onAppend;
  }

  /**
   * 追加写入一条新事件。sequence 自动从 1 开始单调自增。
   */
  append(type: string, payload?: Record<string, unknown>): StreamEvent {
    this.currentSequence += 1;
    const event: StreamEvent = {
      sequence: this.currentSequence,
      type,
      payload,
      timestamp: Date.now(),
    };

    this.events.push(event);
    this.onAppend?.(event);
    return event;
  }

  get length(): number {
    return this.events.length;
  }

  get lastSequence(): number {
    return this.currentSequence;
  }

  getEvents(): readonly StreamEvent[] {
    return this.events;
  }
}

/**
 * 单遍流式投影器：在内存中单遍扫描事件流，构建 ProjectedRunView 聚合状态
 * @param events 异步或同步迭代器
 * @param maxNodes 读侧展示帽，默认 2000
 */
export async function projectStream(
  events: Iterable<StreamEvent> | AsyncIterable<StreamEvent>,
  maxNodes = DEFAULT_MAX_NODES
): Promise<ProjectedRunView> {
  let expectedSeq = 1;
  let runId = 'unknown';
  let status: ProjectedRunView['status'] = 'pending';
  let startedAt = 0;
  let settledAt: number | undefined;
  let totalEvents = 0;

  // Key: `${siteId}#${ordinal}` -> ProjectedNodeView
  const nodeMap = new Map<string, ProjectedNodeView>();
  const nodeInsertionOrder: ProjectedNodeView[] = [];

  for await (const ev of events) {
    totalEvents += 1;

    // 断言 3.1: Sequence 连续自增无断裂
    if (ev.sequence !== expectedSeq) {
      throw new Error(`sequence gap detected in event stream: expected ${expectedSeq}, got ${ev.sequence}`);
    }
    expectedSeq += 1;

    const payload = ev.payload ?? {};

    switch (ev.type) {
      case 'run-started': {
        runId = String(payload.runId ?? runId);
        status = 'running';
        startedAt = ev.timestamp;
        break;
      }

      case 'node-queued':
      case 'node-dispatched':
      case 'node-executing': {
        const siteId = String(payload.siteId ?? 'site');
        const ordinal = Number(payload.ordinal ?? 0);
        const key = `${siteId}#${ordinal}`;

        let node = nodeMap.get(key);
        if (!node) {
          node = {
            siteId,
            ordinal,
            kind: String(payload.kind ?? 'ask'),
            status: 'running',
            actorSeq: typeof payload.actorSeq === 'number' ? payload.actorSeq : undefined,
            timeCreated: ev.timestamp,
          };
          nodeMap.set(key, node);
          nodeInsertionOrder.push(node);
        } else {
          node.status = 'running';
        }
        break;
      }

      case 'node-settled': {
        const siteId = String(payload.siteId ?? 'site');
        const ordinal = Number(payload.ordinal ?? 0);
        const key = `${siteId}#${ordinal}`;

        let node = nodeMap.get(key);
        if (!node) {
          node = {
            siteId,
            ordinal,
            kind: String(payload.kind ?? 'ask'),
            status: payload.ok === false ? 'failed' : 'completed',
            actorSeq: typeof payload.actorSeq === 'number' ? payload.actorSeq : undefined,
            result: payload.result,
            error: payload.error,
            timeCreated: ev.timestamp,
            timeSettled: ev.timestamp,
          };
          nodeMap.set(key, node);
          nodeInsertionOrder.push(node);
        } else {
          node.status = payload.ok === false ? 'failed' : 'completed';
          node.result = payload.result;
          node.error = payload.error;
          node.timeSettled = ev.timestamp;
        }
        break;
      }

      case 'run-settled': {
        const s = String(payload.status ?? 'completed');
        status = (['completed', 'failed', 'cancelled'].includes(s) ? s : 'completed') as ProjectedRunView['status'];
        settledAt = ev.timestamp;
        break;
      }

      default:
        // 其他扩展事件正常流经，不阻断投影
        break;
    }
  }

  const totalNodesCount = nodeInsertionOrder.length;
  const isCapped = totalNodesCount > maxNodes;

  // 断言 3.2: 展示帽截断且底层事实不损
  const displayedNodes = isCapped ? nodeInsertionOrder.slice(0, maxNodes) : nodeInsertionOrder;

  return {
    runId,
    status,
    totalEvents,
    nodes: displayedNodes,
    nodesUnlisted: isCapped ? true : undefined,
    totalNodesCount,
    startedAt,
    settledAt,
  };
}
