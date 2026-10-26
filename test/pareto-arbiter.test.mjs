import test from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionEngine, ParetoArbiter } from '../packages/dwfx-core/src/index.ts';

function candidate(id, vector, overrides = {}) {
  const [changedFiles, changedLines, requestCount, tokenCount, durationMs] = vector;
  return {
    id,
    taskId: 'task-pareto',
    baseline: 'base-1',
    operator: 'draft',
    parentIds: [],
    diffPatch: `patch ${id}`,
    patchHash: overrides.patchHash ?? id,
    changedFilePaths: [`${id}.ts`],
    status: overrides.status ?? 'passed',
    metrics: {
      changedFiles,
      changedLines,
      requestCount,
      tokenCount,
      durationMs,
      exitCode: overrides.exitCode ?? 0,
      testPassRatio: overrides.testPassRatio ?? 1,
    },
  };
}

test('ParetoArbiter filters hard-gate failures, removes dominated solutions, and picks deterministically', () => {
  const balanced = candidate('balanced', [2, 10, 1, 100, 30]);
  const dominated = candidate('dominated', [3, 20, 2, 200, 40]);
  const smallest = candidate('smallest', [1, 100, 2, 120, 50]);
  const failed = candidate('failed', [0, 0, 0, 0, 1], { exitCode: 1, testPassRatio: 0.5 });
  const arbiter = new ParetoArbiter();

  const result = arbiter.arbitrate([dominated, failed, balanced, smallest]);
  assert.deepEqual(result.eligible.map((item) => item.id), ['dominated', 'balanced', 'smallest']);
  assert.deepEqual(result.frontier.map((item) => item.id), ['smallest', 'balanced']);
  assert.equal(result.champion.id, 'smallest');
  assert.deepEqual(arbiter.arbitrate([smallest, balanced, dominated]).champion.id, 'smallest');
});

test('ParetoArbiter applies token, duration, and patch-hash tie breaks in order', () => {
  const arbiter = new ParetoArbiter();
  const lowToken = candidate('low-token', [1, 5, 9, 10, 100], { patchHash: 'ff' });
  const highToken = candidate('high-token', [1, 5, 0, 20, 1], { patchHash: '00' });
  assert.equal(arbiter.selectChampion([highToken, lowToken]).id, 'low-token');

  const fast = candidate('fast', [1, 5, 0, 10, 1], { patchHash: 'ff' });
  const slow = candidate('slow', [1, 5, 0, 10, 2], { patchHash: '00' });
  assert.equal(arbiter.selectChampion([slow, fast]).id, 'fast');

  const hashA = candidate('z-id', [1, 5, 0, 10, 1], { patchHash: 'aa' });
  const hashB = candidate('a-id', [1, 5, 0, 10, 1], { patchHash: 'bb' });
  assert.equal(arbiter.selectChampion([hashB, hashA]).id, 'z-id');
});

test('crossover requires passing same-baseline disjoint parents and remains pending until re-gated', () => {
  const engine = new EvolutionEngine({ runId: 'task-crossover' });
  const registration = { baseline: 'commit-1' };
  const a = engine.registerCandidate('draft', 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+const a = 1;\n', [], registration);
  const b = engine.registerCandidate('draft', 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n+const b = 2;\n', [], registration);
  assert.throws(() => engine.crossover(a.id, b.id), /must pass the full test gate/);

  for (const item of [a, b]) {
    engine.reportEvaluation(item.id, { exitCode: 0, durationMs: 10, testPassRatio: 1 });
  }
  const merged = engine.crossover(a.id, b.id);
  assert.equal(merged.status, 'pending');
  assert.equal(merged.baseline, 'commit-1');
  assert.deepEqual(merged.changedFilePaths, ['a.ts', 'b.ts']);
  assert.notEqual(new ParetoArbiter().selectChampion([a, b, merged]).id, merged.id);

  engine.reportEvaluation(merged.id, { exitCode: 0, durationMs: 10, testPassRatio: 1 });
  assert.equal(merged.status, 'passed');

  const overlap = engine.registerCandidate('draft', 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+const other = 3;\n', [], registration);
  engine.reportEvaluation(overlap.id, { exitCode: 0, durationMs: 10, testPassRatio: 1 });
  assert.throws(() => engine.crossover(a.id, overlap.id), /overlapping files/);

  const otherBase = engine.registerCandidate('draft', 'diff --git a/c.ts b/c.ts\n--- a/c.ts\n+++ b/c.ts\n+const c = 4;\n', [], { baseline: 'commit-2' });
  engine.reportEvaluation(otherBase.id, { exitCode: 0, durationMs: 10, testPassRatio: 1 });
  assert.throws(() => engine.crossover(a.id, otherBase.id), /same task baseline/);
});

test('deadlock counters are task-scoped and reset only after that task passes', () => {
  const engine = new EvolutionEngine({ runId: 'task-a', maxDebugRounds: 2 });
  const failure = { exitCode: 1, durationMs: 1, testPassRatio: 0, stderr: 'same failure' };
  const a = engine.registerCandidate('draft', '', [], { taskId: 'task-a' });
  const b1 = engine.registerCandidate('draft', '', [], { taskId: 'task-b' });
  const firstA = engine.reportEvaluation(a.id, failure);
  engine.reportEvaluation(b1.id, failure);
  const hash = firstA.candidate.normalizedErrorHash;
  assert.equal(engine.getErrorAttempts(hash, 'task-a'), 1);
  assert.equal(engine.getErrorAttempts(hash, 'task-b'), 1);
  assert.equal(b1.status, 'failed');

  const b2 = engine.registerCandidate('debug', '', [], { taskId: 'task-b' });
  assert.equal(engine.reportEvaluation(b2.id, failure).requiresEscalation, true);
  assert.equal(engine.getErrorAttempts(hash, 'task-a'), 1);

  const b3 = engine.registerCandidate('debug', '', [], { taskId: 'task-b' });
  engine.reportEvaluation(b3.id, { exitCode: 0, durationMs: 1, testPassRatio: 1 });
  assert.equal(engine.getErrorAttempts(hash, 'task-b'), 0);
  assert.equal(engine.getErrorAttempts(hash, 'task-a'), 1);
});
