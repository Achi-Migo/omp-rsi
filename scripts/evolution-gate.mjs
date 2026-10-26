#!/usr/bin/env node
/**
 * scripts/evolution-gate.mjs
 * Deterministic Sandbox Evaluation Gate for OpenRSI in omp host.
 *
 * Runs typecheck and unit tests, computing deterministic reward metrics
 * and FNV-1a error hashes without LLM bias. Typecheck failure fails fast:
 * the test stage is skipped so rejected candidates never pay the suite cost.
 * `--suite-detail` executes each test file as its own stage and reports
 * per-suite counts (used by bootstrap so nothing is executed twice).
 */

import { spawnSync } from 'node:child_process';
import { fnv1a32 } from '../packages/dwfx-core/src/index.ts';

const args = process.argv.slice(2);
let target = 'all';
let suiteDetail = false;
for (const arg of args) {
  if (arg.startsWith('--target=')) {
    target = arg.slice('--target='.length);
  } else if (arg === '--suite-detail') {
    suiteDetail = true;
  }
}

const STAGE_TIMEOUT_MS = Number(process.env.RSI_GATE_STAGE_TIMEOUT_MS ?? 110_000) || 110_000;

const TEST_FILES = [
  'test/pareto-arbiter.test.mjs',
  'test/evolution-lifecycle.test.mjs',
  'test/profiler-learning.test.mjs',
  'test/evolution.test.mjs',
  'test/dwfx-core.test.mjs',
  'test/dwfx-cli.test.mjs',
];

function runStage(name, cmd, cmdArgs) {
  const start = Date.now();
  const res = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    env: process.env,
    timeout: STAGE_TIMEOUT_MS,
    killSignal: 'SIGTERM',
  });
  const durationMs = Date.now() - start;
  return {
    name,
    cmd: `${cmd} ${cmdArgs.join(' ')}`,
    exitCode: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    timedOut: res.error?.code === 'ETIMEDOUT' ?? false,
    durationMs,
  };
}

function parseTapCounts(output, fallbackExitCode) {
  const passMatch = output.match(/# pass (\d+)/);
  const failMatch = output.match(/# fail (\d+)/);
  return {
    passed: passMatch ? Number(passMatch[1]) : 0,
    failed: failMatch ? Number(failMatch[1]) : (fallbackExitCode === 0 ? 0 : 1),
  };
}

const stages = [];
const suites = [];
let skippedStages = 0;

let typecheckFailed = false;
if (target === 'all' || target === 'typecheck') {
  const stage = runStage(
    'typecheck',
    'node',
    ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'],
  );
  stages.push(stage);
  typecheckFailed = stage.exitCode !== 0;
}

if (target === 'all' || target === 'test') {
  if (target === 'all' && typecheckFailed) {
    skippedStages += 1;
  } else if (suiteDetail) {
    for (const file of TEST_FILES) {
      const stage = runStage(`suite:${file}`, 'node', [file]);
      const counts = parseTapCounts(`${stage.stdout}\n${stage.stderr}`, stage.exitCode);
      stages.push(stage);
      suites.push({ file, ...counts, exitCode: stage.exitCode, durationMs: stage.durationMs });
    }
  } else {
    stages.push(runStage('test', 'node', ['--test', ...TEST_FILES]));
  }
}

let passedStages = 0;
let totalDurationMs = 0;
let aggregatedStderr = '';
let overallExitCode = 0;

for (const stage of stages) {
  totalDurationMs += stage.durationMs;
  if (stage.exitCode === 0) {
    passedStages += 1;
  } else {
    overallExitCode = stage.exitCode;
    aggregatedStderr += `[${stage.cmd}] failed (exitCode=${stage.exitCode}${stage.timedOut ? ', timedOut' : ''}):\n${stage.stderr || stage.stdout}\n`;
  }
}

const passRatio = stages.length > 0 ? passedStages / stages.length : 1.0;
const ok = overallExitCode === 0 && passRatio === 1.0;

let errorHash = '';
if (!ok) {
  const cleaned = aggregatedStderr
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '')
    .replace(/\/tmp\/[a-zA-Z0-9_-]+/g, '/tmp/<temp>')
    .replace(/:\d+:\d+/g, ':<loc>')
    .replace(/\s+/g, ' ')
    .trim();
  errorHash = fnv1a32(cleaned);
}

const report = {
  ok,
  target,
  totalStages: stages.length,
  passedStages,
  skippedStages,
  passRatio,
  durationMs: totalDurationMs,
  exitCode: overallExitCode,
  errorHash,
  stages: stages.map(({ name, cmd, exitCode, durationMs, timedOut }) => ({
    name,
    cmd,
    exitCode,
    durationMs,
    timedOut,
  })),
  ...(suites.length > 0 ? { suites } : {}),
};

// Output deterministic JSON format for tools and hooks to consume
console.log(JSON.stringify(report, null, 2));

process.exit(ok ? 0 : 1);
