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
export class KeyedScheduler {
    maxConcurrency;
    attempts;
    baseDelayMs;
    signal;
    onTerminal;
    queues = new Map();
    busyActors = new Set();
    active = 0;
    isDraining = false;
    activeTimers = new Set();
    constructor(maxConcurrency, options = {}) {
        if (maxConcurrency < 1) {
            throw new Error(`maxConcurrency must be at least 1, got ${maxConcurrency}`);
        }
        this.maxConcurrency = maxConcurrency;
        this.attempts = options.attempts ?? 3;
        this.baseDelayMs = options.baseDelayMs ?? 400;
        this.signal = options.signal;
        this.onTerminal = options.onTerminal;
        if (this.signal) {
            if (this.signal.aborted) {
                this.abortAll(this.signal.reason);
            }
            else {
                this.signal.addEventListener('abort', () => {
                    this.abortAll(this.signal?.reason);
                }, { once: true });
            }
        }
    }
    /**
     * 将任务入队到指定 actor 标识的 FIFO 队列中。
     * 入队即自动触发 pumpAll() 泵活。
     */
    enqueue(actor, task) {
        if (this.signal?.aborted) {
            const abortError = new Error(`task rejected: scheduler signal aborted (${String(this.signal.reason)})`);
            abortError.name = 'AbortError';
            return Promise.reject(abortError);
        }
        const { promise, resolve, reject } = Promise.withResolvers();
        const item = {
            actor,
            task: task,
            resolve: resolve,
            reject,
        };
        let q = this.queues.get(actor);
        if (!q) {
            q = [];
            this.queues.set(actor, q);
        }
        q.push(item);
        this.pumpAll();
        return promise;
    }
    /**
     * 泵活调度器：在 maxConcurrency 约束内，按 actor 插入序启动各非空队列的队头。
     * 保证同 actor 串行、跨 actor 并行。
     */
    pumpAll() {
        if (this.signal?.aborted)
            return;
        while (this.active < this.maxConcurrency) {
            const next = this.takeNextEligible();
            if (!next) {
                break;
            }
            this.active += 1;
            this.busyActors.add(next.actor);
            // 异步执行并捕获所有异常，绝不逃逸
            void this.runTask(next);
        }
    }
    /** 当前在飞任务数 */
    get running() {
        return this.active;
    }
    /** 排队中的总任务数 */
    get queuedCount() {
        let total = 0;
        for (const q of this.queues.values()) {
            total += q.length;
        }
        return total;
    }
    /** 取下一个满足调度条件的项目（同 actor FIFO，无在飞） */
    takeNextEligible() {
        for (const [actor, queue] of this.queues.entries()) {
            if (queue.length > 0 && !this.busyActors.has(actor)) {
                return queue.shift();
            }
        }
        return undefined;
    }
    /** 任务执行核心循环：二分类错误重试与指数退避 */
    async runTask(item) {
        const { actor, task, resolve, reject } = item;
        let lastError;
        try {
            for (let attempt = 1;; attempt += 1) {
                if (this.signal?.aborted) {
                    const err = new Error('task aborted by scheduler signal');
                    err.name = 'AbortError';
                    reject(err);
                    return;
                }
                try {
                    const res = await task.work(this.signal);
                    resolve(res);
                    return;
                }
                catch (error) {
                    lastError = error;
                    // 错误分类断言：默认非指定即视为瞬时基础设施错
                    const isTransient = task.isProviderError ? task.isProviderError(error) : true;
                    // 确定性错误（业务错）或尝试次数耗尽：不可重试，进入终局
                    if (!isTransient || attempt >= this.attempts) {
                        this.safeOnTerminal(task, error);
                        reject(error);
                        return;
                    }
                    // 瞬时基础设施错：执行 delay(baseDelayMs * 2^attempt)
                    const delayMs = this.baseDelayMs * (2 ** attempt);
                    try {
                        await this.delay(delayMs);
                    }
                    catch (abortErr) {
                        this.safeOnTerminal(task, abortErr);
                        reject(abortErr);
                        return;
                    }
                }
            }
        }
        finally {
            this.busyActors.delete(actor);
            this.active -= 1;
            // 及时清理空队列 Map
            const q = this.queues.get(actor);
            if (q && q.length === 0) {
                this.queues.delete(actor);
            }
            // 任务结算后立即触发下一轮泵活
            this.pumpAll();
        }
    }
    /** 可被 AbortSignal 立即中断的休眠 */
    delay(ms) {
        const { promise, resolve, reject } = Promise.withResolvers();
        if (this.signal?.aborted) {
            const err = new Error('delay aborted');
            err.name = 'AbortError';
            reject(err);
            return promise;
        }
        let timer;
        const onAbort = () => {
            clearTimeout(timer);
            this.activeTimers.delete(timer);
            const err = new Error('delay interrupted by abort');
            err.name = 'AbortError';
            reject(err);
        };
        timer = setTimeout(() => {
            this.activeTimers.delete(timer);
            this.signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        this.activeTimers.add(timer);
        this.signal?.addEventListener('abort', onAbort, { once: true });
        return promise;
    }
    /** 调用宿主 onTerminal 并添加异常安全保护网 */
    safeOnTerminal(task, error) {
        if (!this.onTerminal)
            return;
        try {
            this.onTerminal(task, error);
        }
        catch {
            // 安全网：宿主回调异常严禁打崩调度器
        }
    }
    /** 中断所有定时器并拒绝未决排队项 */
    abortAll(reason) {
        for (const timer of this.activeTimers) {
            clearTimeout(timer);
        }
        this.activeTimers.clear();
        const abortError = new Error(`scheduler aborted: ${String(reason)}`);
        abortError.name = 'AbortError';
        for (const [actor, queue] of this.queues.entries()) {
            while (queue.length > 0) {
                const item = queue.shift();
                this.safeOnTerminal(item.task, abortError);
                item.reject(abortError);
            }
        }
        this.queues.clear();
    }
    /** 等待所有在飞与排队任务离场（用于测试与整体验收） */
    async drain() {
        if (this.active === 0 && this.queuedCount === 0) {
            return;
        }
        const { promise, resolve } = Promise.withResolvers();
        const check = () => {
            if (this.active === 0 && this.queuedCount === 0) {
                resolve();
            }
            else {
                setTimeout(check, 10);
            }
        };
        check();
        return promise;
    }
}
