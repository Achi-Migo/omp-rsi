#!/usr/bin/env node
/**
 * scripts/perf-baseline.mjs
 *
 * Wall-clock baseline for every verification stage: typecheck, each test
 * suite, and the full sandbox gate. Read-only for the repository; emits a
 * deterministic JSON report so optimization work can be measured, not guessed.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..');

const TEST_FILES = [
  'test/pareto-arbiter.test.mjs',
  'test/evolution-lifecycle.test.mjs',
  'test/profiler-learning.test.mjs',
  'test/evolution.test.mjs',
  'test/dwfx-core.test.mjs',
  'test/dwfx-cli.test.mjs',
];

function timeStage(label, cmd, cmdArgs) {
  const start = Date.now();
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT_DIR, encoding: 'utf8' });
  return { label, exitCode: res.status ?? 1, durationMs: Date.now() - start };
}

const results = [];
results.push(timeStage('typecheck', 'node', [
  'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json',
]));
for (const file of TEST_FILES) {
  results.push(timeStage(`suite:${path.basename(file, '.test.mjs')}`, 'node', [file]));
}
results.push(timeStage('gate:all', 'node', ['scripts/evolution-gate.mjs', '--target=all']));

const totalMs = results.reduce((sum, stage) => sum + stage.durationMs, 0);
const failed = results.filter((stage) => stage.exitCode !== 0).map((stage) => stage.label);

console.log(JSON.stringify({
  totalMs,
  allPassed: failed.length === 0,
  ...(failed.length > 0 ? { failedStages: failed } : {}),
  results,
}, null, 2));

process.exit(failed.length === 0 ? 0 : 1);
