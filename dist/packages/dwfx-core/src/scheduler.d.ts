/**
 * dwfx-core - INV-2: 同键 FIFO 调度器与错误二分类重试
 *
 * 契约保证：
 * 1. 同 actor FIFO：同一 actor 的任务严格串行，队头未结算后续不得启动
 * 2. 全局并发上限：活跃总在飞任务数 <= maxConcurrency
 * 3. 错误二分类：确定性错误立即 onTerminal，瞬时错误以 baseDelayMs * 2^attempt 退避重试
 * 4. AbortSignal 可中断支持：外部取消时清除正在休眠的定时器，清空排队
 * 5. 错误安全网：onTerminal 回调异常不逃逸
 */
export interface SchedulableTask<T = unknown> {
    /** 任务执行体 */
    work(signal?: AbortSignal): Promise<T>;
    /** 错误分类谓词：true 表示瞬时可重试错误；false 表示确定性不可重试错误 */
    isProviderError?(error: unknown): boolean;
}
export interface KeyedSchedulerOptions {
    /** 瞬时错误的最大尝试次数（首次执行 + 重试次数），缺省为 3 */
    attempts?: number;
    /** 指数退避基准毫秒（第 attempt 次等待 baseDelayMs * 2^attempt），缺省为 400 */
    baseDelayMs?: number;
    /** 全局外部取消信号 */
    signal?: AbortSignal;
    /** 任务终局结算回调（重试耗尽或确定性失败时调用） */
    onTerminal?(task: SchedulableTask, error: unknown): void;
}
export declare class KeyedScheduler {
    private readonly maxConcurrency;
    private readonly attempts;
    private readonly baseDelayMs;
    private readonly signal?;
    private readonly onTerminal?;
    private readonly queues;
    private readonly busyActors;
    private active;
    private isDraining;
    private readonly activeTimers;
    constructor(maxConcurrency: number, options?: KeyedSchedulerOptions);
    /**
     * 将任务入队到指定 actor 标识的 FIFO 队列中。
     * 入队即自动触发 pumpAll() 泵活。
     */
    enqueue<T = unknown>(actor: string, task: SchedulableTask<T>): Promise<T>;
    /**
     * 泵活调度器：在 maxConcurrency 约束内，按 actor 插入序启动各非空队列的队头。
     * 保证同 actor 串行、跨 actor 并行。
     */
    pumpAll(): void;
    /** 当前在飞任务数 */
    get running(): number;
    /** 排队中的总任务数 */
    get queuedCount(): number;
    /** 取下一个满足调度条件的项目（同 actor FIFO，无在飞） */
    private takeNextEligible;
    /** 任务执行核心循环：二分类错误重试与指数退避 */
    private runTask;
    /** 可被 AbortSignal 立即中断的休眠 */
    private delay;
    /** 调用宿主 onTerminal 并添加异常安全保护网 */
    private safeOnTerminal;
    /** 中断所有定时器并拒绝未决排队项 */
    private abortAll;
    /** 等待所有在飞与排队任务离场（用于测试与整体验收） */
    drain(): Promise<void>;
}
