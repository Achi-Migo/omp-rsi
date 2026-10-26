/**
 * dwfx-core - INV-1: 账本幂等配对与终局合成
 * 
 * 契约保证：
 * 1. 单调严格自增分配整数 seq (>= 1)
 * 2. 内部内聚 live 集合，状态分为 ACTIVE 与 SETTLED
 * 3. end(seq, outcome) 调用幂等
 * 4. close() 终局方法遍历所有 live 轮次，合成 end(seq, 'cancelled')，且拒绝后续 begin
 */

export type AgentOutcome = 'completed' | 'failed' | 'cancelled';

export interface AgentInfo {
  readonly seq: number;
  readonly label: string;
  readonly childId?: string;
  readonly counted: boolean;
  readonly startedAt: number;
}

export interface LedgerEvent {
  readonly type: 'agent-start' | 'agent-end';
  readonly seq: number;
  readonly label: string;
  readonly outcome?: AgentOutcome;
  readonly timestamp: number;
}

export interface LedgerOptions {
  readonly onEvent?: (event: LedgerEvent) => void;
}

export class Ledger {
  private currentSeq = 0;
  private readonly live = new Map<number, AgentInfo>();
  private readonly ended = new Set<number>();
  private countedBegins = 0;
  private closed = false;
  private readonly onEvent?: (event: LedgerEvent) => void;

  constructor(options: LedgerOptions = {}) {
    this.onEvent = options.onEvent;
  }

  /**
   * 启动一个 Agent 轮次。
   * @throws Error 若账本已处于 closed 终态
   */
  begin(label: string, childId?: string, counted = true): number {
    if (this.closed) {
      throw new Error(`cannot begin agent turn "${label}": ledger is closed`);
    }

    this.currentSeq += 1;
    const seq = this.currentSeq;

    if (counted) {
      this.countedBegins += 1;
    }

    const info: AgentInfo = {
      seq,
      label,
      childId,
      counted,
      startedAt: Date.now(),
    };

    this.live.set(seq, info);

    this.onEvent?.({
      type: 'agent-start',
      seq,
      label,
      timestamp: info.startedAt,
    });

    return seq;
  }

  /**
   * 结算指定 seq 轮次。重复调用必须幂等忽略。
   * @returns true 表示成功结算；false 表示已被重复调用或不存在
   */
  end(seq: number, outcome: AgentOutcome = 'completed'): boolean {
    if (this.ended.has(seq)) {
      // 幂等忽略：重复 end 不产生任何新副作用
      return false;
    }

    const info = this.live.get(seq);
    if (!info) {
      return false;
    }

    this.ended.add(seq);
    this.live.delete(seq);

    this.onEvent?.({
      type: 'agent-end',
      seq,
      label: info.label,
      outcome,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * 终局关闭：遍历所有尚未结算的存活轮次，恰好一次合成 cancelled 终态。
   * 执行后账本转入 closed 状态，任何后续 begin 均直接抛错。
   * @returns 合成取消的轮次数
   */
  close(): number {
    if (this.closed) {
      return 0;
    }

    this.closed = true;
    let synthesized = 0;

    // 复制快照遍历，防止迭代中变异
    const activeTurns = [...this.live.values()];
    for (const info of activeTurns) {
      if (this.end(info.seq, 'cancelled')) {
        synthesized += 1;
      }
    }

    return synthesized;
  }

  /** 当前仍存活的轮次数（断言 1.1: close() 后恒等于 0） */
  get liveCount(): number {
    return this.live.size;
  }

  /** 已启动的计费 Agent 轮次总数（断言 1.3） */
  get agentsStarted(): number {
    return this.countedBegins;
  }

  /** 账本是否已关闭 */
  get isClosed(): boolean {
    return this.closed;
  }

  /** 获取指定存活轮次信息 */
  getLive(seq: number): AgentInfo | undefined {
    return this.live.get(seq);
  }

  /** 检查指定 seq 是否已被结算 */
  isEnded(seq: number): boolean {
    return this.ended.has(seq);
  }
}
