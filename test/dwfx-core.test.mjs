import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Ledger,
  KeyedScheduler,
  MemoryJournalWriter,
  projectStream,
  snapshotJsonValue,
  fnv1a32,
  MaterializeError,
} from '../packages/dwfx-core/src/index.ts';

// ---------------------------------------------------------------------------
// INV-1: Ledger 单元测试与故障注入
// ---------------------------------------------------------------------------
test('INV-1: Ledger 基础单调性与配对', () => {
  const events = [];
  const ledger = new Ledger({
    onEvent: (ev) => events.push(ev),
  });

  const seq1 = ledger.begin('actor-A');
  const seq2 = ledger.begin('actor-B');
  assert.equal(seq1, 1);
  assert.equal(seq2, 2);
  assert.equal(ledger.liveCount, 2);
  assert.equal(ledger.agentsStarted, 2);

  // 结算 seq1
  assert.equal(ledger.end(seq1, 'completed'), true);
  assert.equal(ledger.liveCount, 1);
  assert.equal(ledger.isEnded(seq1), true);

  // 重复结算必须幂等忽略 (断言 1.2)
  assert.equal(ledger.end(seq1, 'completed'), false);
  assert.equal(ledger.liveCount, 1);

  // 事件流 1:1 配对
  const startCount = events.filter((e) => e.type === 'agent-start').length;
  const endCount = events.filter((e) => e.type === 'agent-end').length;
  assert.equal(startCount, 2);
  assert.equal(endCount, 1);
});

test('INV-1 故障注入: 终局合成 cancelled 与关闭后防竞争态', () => {
  const events = [];
  const ledger = new Ledger({
    onEvent: (ev) => events.push(ev),
  });

  const s1 = ledger.begin('agent-1');
  const s2 = ledger.begin('agent-2');
  ledger.end(s1, 'completed');

  // 当前 s2 仍悬空在 live 中
  assert.equal(ledger.liveCount, 1);

  // 执行终局收尾
  const synthesized = ledger.close();
  assert.equal(synthesized, 1);
  assert.equal(ledger.liveCount, 0); // 断言 1.1: 终局无残留恒成立
  assert.equal(ledger.isEnded(s2), true);

  const s2End = events.find((e) => e.seq === s2 && e.type === 'agent-end');
  assert.equal(s2End?.outcome, 'cancelled');

  // 关闭后再次 begin 必须抛错拒收，杜绝竞争态
  assert.throws(() => {
    ledger.begin('late-agent');
  }, /ledger is closed/);
});

// ---------------------------------------------------------------------------
// INV-2: KeyedScheduler 单元测试与故障注入
// ---------------------------------------------------------------------------
test('INV-2: 同 actor FIFO 串行性保障', async () => {
  const scheduler = new KeyedScheduler(4);
  const log = [];

  const t1 = scheduler.enqueue('actor-1', {
    work: async () => {
      await new Promise((r) => setTimeout(r, 50));
      log.push('t1-done');
      return 1;
    },
  });

  const t2 = scheduler.enqueue('actor-1', {
    work: async () => {
      log.push('t2-done');
      return 2;
    },
  });

  const [r1, r2] = await Promise.all([t1, t2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.deepEqual(log, ['t1-done', 't2-done']);
});

test('INV-2: 全局并发帽约束', async () => {
  const maxConcurrency = 2;
  const scheduler = new KeyedScheduler(maxConcurrency);
  let activePeak = 0;

  const makeTask = (id) =>
    scheduler.enqueue(`actor-${id}`, {
      work: async () => {
        activePeak = Math.max(activePeak, scheduler.running);
        assert.ok(scheduler.running <= maxConcurrency);
        await new Promise((r) => setTimeout(r, 30));
        return id;
      },
    });

  const results = await Promise.all([makeTask(1), makeTask(2), makeTask(3), makeTask(4)]);
  assert.equal(results.length, 4);
  assert.equal(activePeak, maxConcurrency);
});

test('INV-2 故障注入: 确定性错误立即终止不重试', async () => {
  const scheduler = new KeyedScheduler(2, { attempts: 3, baseDelayMs: 20 });
  let attemptsMade = 0;
  let terminalCalled = false;

  await assert.rejects(
    async () => {
      await scheduler.enqueue('actor-deterministic', {
        work: async () => {
          attemptsMade += 1;
          throw new Error('business logic syntax error');
        },
        isProviderError: () => false, // 确定性错误
      });
    },
    /business logic syntax error/
  );

  // 断言 2.2: 确定性错误执行次数恰好为 1，不产生任何重试放大
  assert.equal(attemptsMade, 1);
});

test('INV-2 故障注入: 瞬时错误指数退避并重试', async () => {
  const scheduler = new KeyedScheduler(2, { attempts: 3, baseDelayMs: 15 });
  let attemptsMade = 0;

  const result = await scheduler.enqueue('actor-retry', {
    work: async () => {
      attemptsMade += 1;
      if (attemptsMade < 3) {
        throw new Error('rate limit 429');
      }
      return 'recovered';
    },
    isProviderError: () => true, // 瞬时错误
  });

  assert.equal(result, 'recovered');
  assert.equal(attemptsMade, 3);
});

test('INV-2 故障注入: AbortSignal 取消时立即中断休眠', async () => {
  const controller = new AbortController();
  const scheduler = new KeyedScheduler(2, {
    attempts: 5,
    baseDelayMs: 5000, // 超长延迟
    signal: controller.signal,
  });

  const taskPromise = scheduler.enqueue('actor-abort', {
    work: async () => {
      throw new Error('network down');
    },
    isProviderError: () => true,
  });

  // 等待首次执行抛错进入退避休眠后取消
  setTimeout(() => controller.abort('user cancel'), 30);

  const start = Date.now();
  await assert.rejects(async () => {
    await taskPromise;
  }, /abort/i);
  const duration = Date.now() - start;

  // 必须立即中断，远小于 5000ms
  assert.ok(duration < 500);
});

// ---------------------------------------------------------------------------
// INV-3: Journal & OnePassProjection 单元测试与故障注入
// ---------------------------------------------------------------------------
test('INV-3: 单遍流式投影与状态聚合', async () => {
  const writer = new MemoryJournalWriter();
  writer.append('run-started', { runId: 'run-alpha' });
  writer.append('node-executing', { siteId: 'ask-1', ordinal: 0, kind: 'ask' });
  writer.append('node-settled', { siteId: 'ask-1', ordinal: 0, kind: 'ask', ok: true, result: 'answer' });
  writer.append('run-settled', { status: 'completed' });

  const view = await projectStream(writer.getEvents());
  assert.equal(view.runId, 'run-alpha');
  assert.equal(view.status, 'completed');
  assert.equal(view.nodes.length, 1);
  assert.equal(view.nodes[0].status, 'completed');
  assert.equal(view.nodes[0].result, 'answer');
  assert.equal(view.nodesUnlisted, undefined);
});

test('INV-3 故障注入: Sequence 断裂时显式报错', async () => {
  const badEvents = [
    { sequence: 1, type: 'run-started', timestamp: 100 },
    { sequence: 3, type: 'run-settled', timestamp: 200 }, // 跳过 2
  ];

  await assert.rejects(async () => {
    await projectStream(badEvents);
  }, /sequence gap detected/);
});

test('INV-3: 展示帽截断且底层事实不损', async () => {
  const writer = new MemoryJournalWriter();
  writer.append('run-started', { runId: 'capped-run' });

  // 写入 5 个节点，但测试展示帽限制为 3
  for (let i = 0; i < 5; i += 1) {
    writer.append('node-settled', { siteId: 'node', ordinal: i, ok: true });
  }

  const view = await projectStream(writer.getEvents(), 3);
  assert.equal(view.totalNodesCount, 5); // 事实总数未丢
  assert.equal(view.nodes.length, 3); // 展示被截断为 3
  assert.equal(view.nodesUnlisted, true); // 显式标记未列全
});

// ---------------------------------------------------------------------------
// INV-4: JSON 无损落盘与指纹确定性
// ---------------------------------------------------------------------------
test('INV-4: 严格拦截非法类型与深度溢出', () => {
  // 顶层 undefined
  assert.throws(() => snapshotJsonValue(undefined), MaterializeError);

  // 非有限数
  assert.throws(() => snapshotJsonValue(NaN), MaterializeError);
  assert.throws(() => snapshotJsonValue(Infinity), MaterializeError);

  // 不支持的类型
  assert.throws(() => snapshotJsonValue(BigInt(123)), MaterializeError);
  assert.throws(() => snapshotJsonValue(Symbol('sym')), MaterializeError);
  assert.throws(() => snapshotJsonValue(() => {}), MaterializeError);

  // 深度超限
  let deepObj = {};
  let cur = deepObj;
  for (let i = 0; i < 70; i += 1) {
    cur.child = {};
    cur = cur.child;
  }
  assert.throws(() => snapshotJsonValue(deepObj), MaterializeError);

  // 合法 JSON 过滤对象内 undefined
  const clean = snapshotJsonValue({ a: 1, b: undefined, c: 'hello' });
  assert.deepEqual(clean, { a: 1, c: 'hello' });
});

test('INV-4: FNV-1a 32 位指纹确定性', () => {
  const hash1 = fnv1a32('ask(model, prompt)');
  const hash2 = fnv1a32('ask(model, prompt)');
  const hash3 = fnv1a32('ask(model, different)');

  assert.equal(hash1.length, 8);
  assert.equal(hash1, hash2);
  assert.notEqual(hash1, hash3);
});
