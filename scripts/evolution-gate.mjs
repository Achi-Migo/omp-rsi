#!/usr/bin/env node
/**
 * scripts/evolution-gate.mjs
 * Deterministic Sandbox Evaluation Gate for OpenRSI in omp host.
 *
 * Runs typecheck, unit tests, and smoke tests, computing deterministic reward metrics
 * and FNV-1a error hashes without LLM bias.
 */

import { spawnSync } from 'node:child_process';
import { fnv1a32 } from '../packages/dwfx-core/src/index.ts';

const args = process.argv.slice(2);
let target = 'all';
for (const arg of args) {
  if (arg.startsWith('--target=')) {
    target = arg.slice('--target='.length);
  }
}

function runStage(cmd, cmdArgs) {
  const start = Date.now();
  const res = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    env: process.env,
  });
  const durationMs = Date.now() - start;
  return {
    cmd: `${cmd} ${cmdArgs.join(' ')}`,
    exitCode: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    durationMs,
  };
}

const stages = [];

if (target === 'all' || target === 'typecheck') {
  stages.push(runStage('node', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']));
}

if (target === 'all' || target === 'test') {
  stages.push(runStage('node', ['--test', 'test/pareto-arbiter.test.mjs', 'test/evolution-lifecycle.test.mjs', 'test/profiler-learning.test.mjs', 'test/evolution.test.mjs', 'test/dwfx-core.test.mjs', 'test/dwfx-cli.test.mjs']));
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
    aggregatedStderr += `[${stage.cmd}] failed (exitCode=${stage.exitCode}):\n${stage.stderr || stage.stdout}\n`;
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
  passRatio,
  durationMs: totalDurationMs,
  exitCode: overallExitCode,
  errorHash,
};

// Output deterministic JSON format for tools and hooks to consume
console.log(JSON.stringify(report, null, 2));

process.exit(ok ? 0 : 1);
