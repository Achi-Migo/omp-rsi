#!/usr/bin/env node
/**
 * scripts/bootstrap.mjs
 *
 * One-click bootstrap, environment inspection, dependency resolution, and a
 * single deterministic gate execution (typecheck + full test suite) for the
 * omp-rsi self-evolution engine.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function logHeader(title) {
  console.log(`\n${COLORS.bold}${COLORS.cyan}=== [${title}] ===${COLORS.reset}`);
}

function logItem(label, status, detail = '') {
  const icon = status ? `${COLORS.green}🟢 PASS${COLORS.reset}` : `${COLORS.red}🔴 FAIL${COLORS.reset}`;
  const extra = detail ? ` ${COLORS.gray}(${detail})${COLORS.reset}` : '';
  console.log(`  ${icon} ${COLORS.bold}${label}${COLORS.reset}${extra}`);
}

const summary = [];

function recordResult(phase, success, message, detail = '') {
  summary.push({ phase, success, message, detail });
  logItem(message, success, detail);
}

// ---------------------------------------------------------------------------
// Phase 1: Environment Inspection
// ---------------------------------------------------------------------------
async function inspectEnvironment() {
  logHeader('Phase 1: Environment & Compute Inspection');

  // 1.1 Node.js version >= 22.6.0
  const nodeVersion = process.versions.node;
  const [major, minor, patch] = nodeVersion.split('.').map(Number);
  const isNodeSupported = major > 22 || (major === 22 && minor >= 6);
  recordResult(
    '1. Environment',
    isNodeSupported,
    'Node.js Version Check',
    `v${nodeVersion} (required >= 22.6.0)`
  );

  // 1.2 node:sqlite built-in support
  let sqliteOk = false;
  let sqliteError = '';
  try {
    const sqlite = await import('node:sqlite');
    const { DatabaseSync } = sqlite;
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE _omp_probe (id INTEGER PRIMARY KEY, probe TEXT)');
    db.prepare('INSERT INTO _omp_probe (probe) VALUES (?)').run('rsi-ok');
    const row = db.prepare('SELECT probe FROM _omp_probe WHERE id = 1').get();
    db.close();
    sqliteOk = row?.probe === 'rsi-ok';
  } catch (err) {
    sqliteError = err instanceof Error ? err.message : String(err);
  }
  recordResult(
    '1. Environment',
    sqliteOk,
    'Built-in node:sqlite Engine',
    sqliteOk ? 'DatabaseSync memory driver verified' : sqliteError
  );

  // 1.3 Git repository verification
  const gitCheck = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  const isGitRepo = gitCheck.status === 0 && gitCheck.stdout.trim() === 'true';
  recordResult(
    '1. Environment',
    isGitRepo,
    'Git Working Tree',
    isGitRepo ? 'valid worktree' : (gitCheck.stderr.trim() || 'not in git repo')
  );

  // 1.4 Hardware resources (2 vCPU / 2 GiB profile)
  const cpuCount = os.cpus().length;
  const totalMemGb = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(1);
  const platform = `${os.platform()} (${os.arch()})`;
  recordResult(
    '1. Environment',
    true,
    'System Hardware & Compute',
    `${cpuCount} CPU cores, ${totalMemGb} GiB RAM, ${platform}`
  );
}

// ---------------------------------------------------------------------------
// Phase 2: Configuration & Dependencies
// ---------------------------------------------------------------------------
function checkConfigAndDependencies() {
  logHeader('Phase 2: Project Configuration & Assets');

  // 2.1 Dependencies check
  let depsOk = false;
  const tsPkgPath = path.join(ROOT_DIR, 'node_modules', 'typescript', 'package.json');
  if (fs.existsSync(tsPkgPath)) {
    depsOk = true;
  } else {
    console.log(`  ${COLORS.yellow}⚠️ node_modules missing, executing npm install...${COLORS.reset}`);
    const install = spawnSync('npm', ['install'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    depsOk = install.status === 0 && fs.existsSync(tsPkgPath);
  }
  recordResult(
    '2. Configuration',
    depsOk,
    'Node Modules & TypeScript DevDependencies',
    depsOk ? 'typescript 5.9.3 & @types/node ready' : 'npm install failed'
  );

  // 2.2 Key configuration files and assets
  const keyAssets = [
    { file: '.omp/config.yml', desc: 'omp runtime configuration' },
    { file: '.omp/tools/evolution.ts', desc: 'evolution_begin / evolution_record tools' },
    { file: '.omp/hooks/pre/context-profiler.ts', desc: 'context-profiler hook' },
    { file: '.omp/hooks/pre/evolution-learner.ts', desc: 'evolution-learner hook' },
    { file: 'assets/omp-host.d.ts', desc: 'omp host ambient type definitions' },
    { file: 'assets/journal-schema.sql', desc: 'SQLite journal DDL schema' },
    { file: 'AGENTS.md', desc: 'omp agent operational specification' },
  ];

  let allAssetsExist = true;
  const missingFiles = [];
  for (const { file } of keyAssets) {
    const fullPath = path.join(ROOT_DIR, file);
    if (!fs.existsSync(fullPath)) {
      allAssetsExist = false;
      missingFiles.push(file);
    }
  }

  recordResult(
    '2. Configuration',
    allAssetsExist,
    'Core Asset & Hook Manifest',
    allAssetsExist ? `${keyAssets.length}/${keyAssets.length} assets verified` : `Missing: ${missingFiles.join(', ')}`
  );
}

// ---------------------------------------------------------------------------
// Phase 3: Deterministic Verification Gate (single execution)
//
// One `evolution-gate.mjs --target=all --suite-detail` run provides the
// typecheck verdict, per-suite TAP counts, and the gate contract itself.
// Phases 3/4/5 previously re-ran typecheck and all tests twice; the whole
// pipeline now executes each stage exactly once.
// ---------------------------------------------------------------------------
const EXPECTED_SUITES = [
  { file: 'test/pareto-arbiter.test.mjs', expected: 4, name: 'Pareto Arbiter & Tie Breaks' },
  { file: 'test/evolution-lifecycle.test.mjs', expected: 9, name: 'Evolution Lifecycle & Worktree Sandbox' },
  { file: 'test/profiler-learning.test.mjs', expected: 2, name: 'Context Profiler & Skill Promotion' },
  { file: 'test/evolution.test.mjs', expected: 2, name: 'Evolution Engine 4 Operators' },
  { file: 'test/dwfx-core.test.mjs', expected: 12, name: 'INV-1 ~ INV-4 Core Invariant Guarantees' },
  { file: 'test/dwfx-cli.test.mjs', expected: 5, name: 'dwfx CLI Commands & Journal Tools' },
];
const EXPECTED_TOTAL = EXPECTED_SUITES.reduce((sum, suite) => sum + suite.expected, 0);

function runVerificationGate() {
  logHeader(`Phase 3: Deterministic Gate — Typecheck + ${EXPECTED_SUITES.length} Suites (single run)`);

  const gateScript = path.join(ROOT_DIR, 'scripts', 'evolution-gate.mjs');
  const start = Date.now();
  const res = spawnSync('node', [gateScript, '--target=all', '--suite-detail'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    timeout: 300_000,
  });
  const duration = Date.now() - start;

  let gateReport = null;
  try {
    gateReport = JSON.parse(res.stdout.trim());
  } catch {
    // Ignore JSON parse error, handled below
  }

  if (!gateReport) {
    recordResult(
      '3. Gate',
      false,
      'Deterministic Evolution Hard Gate',
      `unparseable gate output: exitCode=${res.status}${res.stderr ? `, ${res.stderr.slice(0, 200)}` : ''}`
    );
    return;
  }

  // 3.1 Typecheck verdict (gate stage `typecheck`)
  const typecheckStage = (gateReport.stages ?? []).find((stage) => stage.name === 'typecheck');
  recordResult(
    '3. Gate',
    typecheckStage?.exitCode === 0,
    'TypeScript tsc --noEmit',
    typecheckStage?.exitCode === 0
      ? `0 errors in ${typecheckStage.durationMs}ms`
      : `typecheck stage failed (exitCode=${typecheckStage?.exitCode ?? 'missing'})`
  );

  // 3.2 Per-suite TAP counts (gate `--suite-detail`)
  let totalPassed = 0;
  let totalFailed = 0;
  let allSuitesPresent = true;
  for (const suite of EXPECTED_SUITES) {
    const actual = (gateReport.suites ?? []).find((entry) => entry.file === suite.file);
    if (!actual) {
      allSuitesPresent = false;
      recordResult('3. Gate', false, suite.name, 'suite result missing from gate report');
      continue;
    }
    totalPassed += actual.passed;
    totalFailed += actual.failed;
    const suiteOk = actual.exitCode === 0 && actual.failed === 0 && actual.passed === suite.expected;
    recordResult(
      '3. Gate',
      suiteOk,
      suite.name,
      `${actual.passed}/${suite.expected} passed in ${actual.durationMs}ms`
    );
  }

  const aggregateOk = allSuitesPresent && totalPassed === EXPECTED_TOTAL && totalFailed === 0;
  recordResult(
    '3. Gate',
    aggregateOk,
    `All ${EXPECTED_SUITES.length} Suites Aggregate Integrity`,
    `total ${totalPassed}/${EXPECTED_TOTAL} passed, ${totalFailed} failed`
  );

  // 3.3 Gate contract: exit code, ok flag, and pass ratio
  const gatePassed = res.status === 0 && gateReport.ok === true && gateReport.passRatio === 1.0;
  recordResult(
    '3. Gate',
    gatePassed,
    'Deterministic Evolution Hard Gate',
    gatePassed
      ? `passRatio: 1.0, stages: ${gateReport.passedStages}/${gateReport.totalStages}, ${duration}ms`
      : `Gate failed: exitCode=${res.status}, skippedStages=${gateReport.skippedStages ?? 0}`
  );
}

// ---------------------------------------------------------------------------
// Main Runner & Summary
// ---------------------------------------------------------------------------
async function main() {
  console.log(`${COLORS.bold}${COLORS.green}omp-rsi Bootstrap & Verification Utility${COLORS.reset}`);
  console.log(`${COLORS.gray}Target Directory: ${ROOT_DIR}${COLORS.reset}`);

  await inspectEnvironment();
  checkConfigAndDependencies();
  runVerificationGate();

  logHeader('Summary & Decision Report');
  const failedItems = summary.filter((item) => !item.success);

  console.log(`\n  Total checks executed: ${summary.length}`);
  console.log(`  Passed checks:         ${summary.length - failedItems.length}`);
  console.log(`  Failed checks:         ${failedItems.length}`);

  if (failedItems.length === 0) {
    console.log(`\n${COLORS.bold}${COLORS.green}🎉 ALL CHECKS PASSED: omp-rsi environment is 100% verified and operational.${COLORS.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n${COLORS.bold}${COLORS.red}❌ BOOTSTRAP FAILED on ${failedItems.length} check(s):${COLORS.reset}`);
    for (const f of failedItems) {
      console.log(`   - [${f.phase}] ${f.message}: ${f.detail}`);
    }
    console.log('');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${COLORS.red}Fatal bootstrap error:${COLORS.reset}`, err);
  process.exit(1);
});
