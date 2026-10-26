import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import {
  EvolutionController,
  MAX_PATCH_BYTES,
  evaluateCandidateInSandbox,
} from '../.omp/tools/evolution.ts';
import { RsiStore } from '../src/journal/rsi-store.ts';

function patchFor(file, replacement = 'new') {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${replacement}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-lifecycle-test-'));
}

test('lifecycle keeps global concurrency at one and appends only a re-gated crossover', async () => {
  const cwd = temporaryDirectory();
  const store = new RsiStore(new DatabaseSync(':memory:'));
  let active = 0;
  let peak = 0;
  const evaluationOrder = [];
  const controller = new EvolutionController({
    cwd,
    store,
    applyChampion: false,
    evaluator: async (context) => {
      active += 1;
      peak = Math.max(peak, active);
      evaluationOrder.push(context.candidateId);
      await delay(20);
      active -= 1;
      return { exitCode: 0, durationMs: 5, testPassRatio: 1 };
    },
  });
  try {
    const begun = await controller.begin({ taskId: 'serial-run', objective: 'test serial evaluation' });
    const patchA = patchFor('a.txt');
    const patchB = patchFor('b.txt');
    const first = controller.record({ runId: begun.runId, candidateId: 'cand-draft-1', diffPatch: patchA, patchHash: sha256(patchA) });
    const second = controller.record({ runId: begun.runId, candidateId: 'cand-draft-2', diffPatch: patchB, patchHash: sha256(patchB) });
    const actions = await Promise.all([first, second]);

    assert.equal(peak, 1);
    assert.deepEqual(evaluationOrder, ['cand-draft-1', 'cand-draft-2']);
    assert.equal(actions[0].state, 'waiting');
    assert.equal(actions[1].state, 'awaiting_candidate');
    assert.equal(actions[1].candidateId, 'cand-crossover-3');
    assert.equal(store.listCandidates('serial-run').length, 3);

    const merged = actions[1];
    const completed = await controller.record({
      runId: begun.runId,
      candidateId: merged.candidateId,
      diffPatch: merged.diffPatch,
      patchHash: merged.patchHash,
    });
    assert.equal(completed.state, 'completed');
    assert.equal(completed.applied, false);
    assert.equal(store.getTask('serial-run').status, 'succeeded');
  } finally {
    controller.close();
    store.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('lifecycle gracefully rejects oversized and over-wide patches before evaluation', async () => {
  const cwd = temporaryDirectory();
  const store = new RsiStore(new DatabaseSync(':memory:'));
  let evaluations = 0;
  const controller = new EvolutionController({
    cwd,
    store,
    applyChampion: false,
    evaluator: async () => {
      evaluations += 1;
      return { exitCode: 0, durationMs: 1, testPassRatio: 1 };
    },
  });
  try {
    await controller.begin({ taskId: 'bounded-run', objective: 'enforce patch limits' });
    const oversized = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n+${'x'.repeat(MAX_PATCH_BYTES)}\n`;
    const tooBig = await controller.record({
      runId: 'bounded-run', candidateId: 'cand-draft-1', diffPatch: oversized, patchHash: sha256(oversized),
    });
    assert.equal(tooBig.state, 'rejected');
    assert.match(tooBig.reason, /256|262144/);

    const wide = Array.from({ length: 21 }, (_, index) => patchFor(`file-${index}.ts`)).join('\n');
    const tooWide = await controller.record({
      runId: 'bounded-run', candidateId: 'cand-draft-1', diffPatch: wide, patchHash: sha256(wide),
    });
    assert.equal(tooWide.state, 'rejected');
    assert.match(tooWide.reason, /1\.\.20 files/);
    assert.equal(evaluations, 0);

    const valid = patchFor('valid.ts');
    const recovered = await controller.record({
      runId: 'bounded-run', candidateId: 'cand-draft-1', diffPatch: valid, patchHash: sha256(valid),
    });
    assert.equal(recovered.state, 'awaiting_candidate');
    assert.equal(recovered.candidateId, 'cand-draft-2');
    assert.equal(evaluations, 1);
  } finally {
    controller.close();
    store.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('lifecycle runs two drafts then one debug and atomically applies the champion', async () => {
  const cwd = temporaryDirectory();
  for (const file of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(cwd, file), 'old\n');
  const store = new RsiStore(new DatabaseSync(':memory:'));
  const controller = new EvolutionController({
    cwd,
    store,
    evaluator: async (context) => context.candidateId === 'cand-draft-2'
      ? { exitCode: 1, durationMs: 1, testPassRatio: 0, stderr: 'draft two failed' }
      : { exitCode: 0, durationMs: context.candidateId === 'cand-draft-1' ? 1 : 10, testPassRatio: 1 },
  });
  try {
    await controller.begin({ taskId: 'merge-run', objective: 'merge a verified champion', skillName: 'merge-proof' });
    const patchA = patchFor('a.txt');
    const second = await controller.record({ runId: 'merge-run', candidateId: 'cand-draft-1', diffPatch: patchA, patchHash: sha256(patchA) });
    assert.equal(second.candidateId, 'cand-draft-2');

    const patchB = patchFor('b.txt');
    const third = await controller.record({ runId: 'merge-run', candidateId: 'cand-draft-2', diffPatch: patchB, patchHash: sha256(patchB) });
    assert.equal(third.candidateId, 'cand-debug-3');

    const patchC = patchFor('c.txt');
    const completed = await controller.record({
      runId: 'merge-run', candidateId: 'cand-debug-3', diffPatch: patchC, patchHash: sha256(patchC),
      experience: 'Keep the smallest candidate that passes the complete gate.',
    });
    assert.equal(completed.state, 'completed');
    assert.equal(completed.champion.id, 'cand-draft-1');
    assert.equal(completed.applied, true);
    assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'new\n');
    assert.equal(fs.readFileSync(path.join(cwd, 'b.txt'), 'utf8'), 'old\n');
    assert.equal(fs.readFileSync(path.join(cwd, 'c.txt'), 'utf8'), 'old\n');
    assert.equal(store.getTask('merge-run').experience, 'Keep the smallest candidate that passes the complete gate.');
    assert.equal(store.listCandidates('merge-run').length, 3);
    assert.equal(store.metrics().autonomousRate, 1);
  } finally {
    controller.close();
    store.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('non-Git fallback copy evaluates the patch and cleans its sandbox', async () => {
  const cwd = temporaryDirectory();
  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'old\n');
  fs.writeFileSync(path.join(cwd, 'scripts/evolution-gate.mjs'), gateScript());
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('rsi-cand-')));
  try {
    const result = await evaluateCandidateInSandbox(
      { cwd, baseline: 'working-tree', candidateId: 'fallback-candidate' },
      patchFor('a.txt'),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.testPassRatio, 1);
    assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'old\n');
    const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('rsi-cand-'));
    assert.deepEqual(after, [...before]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Git worktree evaluation passes against modified content and removes the worktree', async () => {
  const cwd = temporaryDirectory();
  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'old\n');
  fs.writeFileSync(path.join(cwd, 'scripts/evolution-gate.mjs'), gateScript());
  git(cwd, ['init']);
  git(cwd, ['add', 'a.txt', 'scripts/evolution-gate.mjs']);
  git(cwd, ['-c', 'user.name=RSI', '-c', 'user.email=rsi@example.invalid', 'commit', '-m', 'initial']);
  const baseline = git(cwd, ['rev-parse', 'HEAD']).trim();
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('rsi-cand-')));
  try {
    const result = await evaluateCandidateInSandbox(
      { cwd, baseline, candidateId: 'worktree-candidate' },
      patchFor('a.txt'),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.testPassRatio, 1);
    assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'old\n');
    assert.doesNotMatch(git(cwd, ['worktree', 'list', '--porcelain']), /rsi-cand-/);
    const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('rsi-cand-'));
    assert.deepEqual(after, [...before]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

function gateScript() {
  return `import { readFileSync } from 'node:fs';\nconst ok = readFileSync('a.txt', 'utf8') === 'new\\n';\nconsole.log(JSON.stringify({ exitCode: ok ? 0 : 1, durationMs: 1, passRatio: ok ? 1 : 0 }));\nprocess.exit(ok ? 0 : 1);\n`;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
