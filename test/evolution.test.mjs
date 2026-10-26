import test from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionEngine, Ledger } from '../packages/dwfx-core/src/index.ts';

test('EvolutionEngine - 4 atomic operators lifecycle', () => {
  const events = [];
  const ledger = new Ledger({
    onEvent: (ev) => events.push(ev),
  });
  const engine = new EvolutionEngine({ maxDebugRounds: 2, ledger });
  // 1. Draft
  const candDraft = engine.registerCandidate('draft', '+function solve() { return 1; }');
  assert.equal(candDraft.operator, 'draft');
  assert.equal(candDraft.status, 'pending');

  const evalDraft = engine.reportEvaluation(candDraft.id, {
    exitCode: 1,
    durationMs: 120,
    testPassRatio: 0.5,
    stderr: 'AssertionError: expected 2 got 1\n at test.js:10:5',
  });
  assert.equal(evalDraft.candidate.status, 'failed');
  assert.equal(evalDraft.requiresEscalation, false);
  assert.ok(evalDraft.candidate.normalizedErrorHash);

  // 2. Debug round 1
  const candDebug1 = engine.registerCandidate('debug', '+function solve() { return 2; }', [candDraft.id]);
  const evalDebug1 = engine.reportEvaluation(candDebug1.id, {
    exitCode: 1,
    durationMs: 105,
    testPassRatio: 0.5,
    stderr: 'AssertionError: expected 2 got 1\n at test.js:12:8', // Same normalized error
  });
  // Same error hash repeated 2nd time -> deadlocked and escalate
  assert.equal(evalDebug1.candidate.status, 'deadlocked');
  assert.equal(evalDebug1.requiresEscalation, true);
  assert.match(evalDebug1.escalationReason || '', /REPAIR_LOOP_DEADLOCK/);

  // 3. Improve
  const candImprove = engine.registerCandidate('improve', '// optimized memory');
  const evalImprove = engine.reportEvaluation(candImprove.id, {
    exitCode: 0,
    durationMs: 80,
    testPassRatio: 1.0,
  });
  assert.equal(evalImprove.candidate.status, 'passed');
  assert.equal(evalImprove.requiresEscalation, false);

  // 4. Crossover requires two fully passing parents and produces a pending re-gated candidate.
  engine.reportEvaluation(candDraft.id, {
    exitCode: 0,
    durationMs: 90,
    testPassRatio: 1.0,
  });
  const candCross = engine.crossover(candDraft.id, candImprove.id);
  assert.equal(candCross.operator, 'crossover');
  assert.equal(candCross.status, 'pending');
  assert.deepEqual(candCross.parentIds, [candDraft.id, candImprove.id]);
  assert.ok(candCross.diffPatch.includes('+function solve() { return 1; }'));
  assert.ok(candCross.diffPatch.includes('// optimized memory'));

  // Verify ledger monotonicity and recording
  assert.ok(events.length >= 6);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].seq >= events[i - 1].seq, 'Ledger seq must be monotonically non-decreasing');
  }
  const startEvents = events.filter((e) => e.type === 'agent-start');
  for (let i = 1; i < startEvents.length; i++) {
    assert.ok(startEvents[i].seq > startEvents[i - 1].seq, 'Start seq must be strictly monotonically increasing');
  }
});

test('EvolutionEngine - error normalization isolates noise', () => {
  const engine = new EvolutionEngine();
  const err1 = '2026-10-26T12:00:00.123Z Error in /tmp/run-abc1234/test.js:42:15 at Object.run (test.js:<loc>)';
  const err2 = '2026-10-26T12:05:30.999Z Error in /tmp/run-xyz9876/test.js:99:3 at Object.run (test.js:<loc>)';

  const hash1 = engine.normalizeError(err1);
  const hash2 = engine.normalizeError(err2);

  assert.equal(hash1, hash2, 'Normalized error hashes should match across timestamps and temporary paths');
});
