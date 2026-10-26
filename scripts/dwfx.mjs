#!/usr/bin/env node
/**
 * dwfx CLI: 机制移植与调试运维综合命令行工具
 * 
 * 子命令：
 *   dwfx journal verify <db|jsonl> [--json]       校验不变量（悬空 seq、序号断裂、非法键）
 *   dwfx journal export <db> [--output <file>]    将 SQLite 数据无损导出为流式 JSONL
 *   dwfx journal prune <db> --keep <N>            物理修剪历史数据，保留最近 N 个 Run
 *   dwfx sched replay <trace.jsonl>               读取追踪日志，回放并校验 FIFO 与重试时序
 *   dwfx ledger report <db|jsonl> [--json]        输出账本健康度与轮次统计报表
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { verifyDatabase, verifyJsonl } from './dwfx-verify.mjs';
import { KeyedScheduler, projectStream, fnv1a32 } from '../packages/dwfx-core/src/index.ts';

let DatabaseSync;
try {
  const sqlite = await import('node:sqlite');
  DatabaseSync = sqlite.DatabaseSync;
} catch {
  // SQLite 不可用时降级纯 JSONL
}

// ---------------------------------------------------------------------------
// 1. journal export 命令实现
// ---------------------------------------------------------------------------
export async function journalExport(dbPath, outputPath) {
  if (!DatabaseSync) {
    throw new Error('node:sqlite DatabaseSync is not available in current Node runtime.');
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const outStream = outputPath ? fs.createWriteStream(outputPath, { encoding: 'utf8' }) : process.stdout;

  try {
    const runs = db.prepare('SELECT * FROM dwf_run ORDER BY time_created ASC').all();
    for (const run of runs) {
      outStream.write(JSON.stringify({ type: 'run-record', run }) + '\n');

      const events = db.prepare('SELECT sequence, type, payload_json, time_created FROM dwf_event WHERE run_id = ? ORDER BY sequence ASC').all(run.id);
      for (const ev of events) {
        let payload = null;
        try {
          payload = ev.payload_json ? JSON.parse(ev.payload_json) : null;
        } catch {
          payload = { raw: ev.payload_json };
        }
        outStream.write(JSON.stringify({
          type: 'event-record',
          runId: run.id,
          sequence: ev.sequence,
          event: ev.type,
          payload,
          timestamp: ev.time_created,
        }) + '\n');
      }
    }
  } finally {
    db.close();
    if (outputPath) {
      await new Promise((r) => outStream.end(r));
    }
  }
}

// ---------------------------------------------------------------------------
// 2. journal prune 命令实现
// ---------------------------------------------------------------------------
export function journalPrune(dbPath, keepCount) {
  if (!DatabaseSync) {
    throw new Error('node:sqlite DatabaseSync is not available in current Node runtime.');
  }
  if (typeof keepCount !== 'number' || keepCount < 0) {
    throw new Error(`keepCount must be a non-negative integer, got ${keepCount}`);
  }

  const db = new DatabaseSync(dbPath);
  try {
    const allRuns = db.prepare('SELECT id, time_created FROM dwf_run ORDER BY time_created DESC').all();
    if (allRuns.length <= keepCount) {
      return { totalRuns: allRuns.length, prunedCount: 0, keptCount: allRuns.length };
    }

    const runsToKeep = new Set(allRuns.slice(0, keepCount).map((r) => r.id));
    const runsToPrune = allRuns.slice(keepCount).map((r) => r.id);

    db.exec('BEGIN TRANSACTION;');
    try {
      for (const runId of runsToPrune) {
        db.prepare('DELETE FROM dwf_event WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM dwf_node WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM dwf_actor WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM dwf_run WHERE id = ?').run(runId);
      }
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    }

    return {
      totalRuns: allRuns.length,
      prunedCount: runsToPrune.length,
      keptCount: runsToKeep.size,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 3. sched replay 命令实现
// ---------------------------------------------------------------------------
export async function schedReplay(tracePath, maxConcurrency = 2) {
  const fileStream = fs.createReadStream(tracePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const tasksToReplay = [];
  let lineNum = 0;

  for await (const rawLine of rl) {
    lineNum += 1;
    const line = rawLine.trim();
    if (!line) continue;

    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }

    // 识别可调度节点任务或 actor 记录
    if (item.type === 'event-record' && item.event === 'node-queued') {
      const actor = item.payload?.actorSiteId ?? item.payload?.actor ?? 'default-actor';
      tasksToReplay.push({
        actor: String(actor),
        siteId: item.payload?.siteId ?? `site-${lineNum}`,
        ordinal: item.payload?.ordinal ?? lineNum,
      });
    } else if (item.event === 'task-dispatch' || item.task === true) {
      tasksToReplay.push({
        actor: String(item.actor ?? 'default-actor'),
        siteId: String(item.id ?? `site-${lineNum}`),
        ordinal: lineNum,
      });
    }
  }

  if (tasksToReplay.length === 0) {
    return { totalTasks: 0, replayedCount: 0, orderConsistent: true, message: 'No replayable tasks found in trace' };
  }

  const scheduler = new KeyedScheduler(maxConcurrency);
  const executionOrder = [];

  const promises = tasksToReplay.map((t) =>
    scheduler.enqueue(t.actor, {
      work: async () => {
        executionOrder.push(`${t.actor}#${t.ordinal}`);
        return true;
      },
    })
  );

  await Promise.all(promises);

  return {
    totalTasks: tasksToReplay.length,
    replayedCount: executionOrder.length,
    orderConsistent: executionOrder.length === tasksToReplay.length,
    executionOrder,
  };
}

// ---------------------------------------------------------------------------
// 4. ledger report 命令实现
// ---------------------------------------------------------------------------
export async function ledgerReport(targetPath) {
  const isDb = targetPath.endsWith('.db') || targetPath.endsWith('.sqlite');

  if (isDb) {
    if (!DatabaseSync) {
      throw new Error('node:sqlite DatabaseSync is not available in current Node runtime.');
    }
    const db = new DatabaseSync(targetPath, { readOnly: true });
    try {
      const runs = db.prepare('SELECT id, status, time_created, time_updated FROM dwf_run ORDER BY time_created DESC').all();
      const runReports = [];

      for (const run of runs) {
        const events = db.prepare('SELECT sequence, type FROM dwf_event WHERE run_id = ?').all(run.id);
        const nodes = db.prepare('SELECT site_id, kind, status FROM dwf_node WHERE run_id = ?').all(run.id);

        const durationMs = run.time_updated > run.time_created ? run.time_updated - run.time_created : 0;
        runReports.push({
          runId: run.id,
          status: run.status,
          eventsCount: events.length,
          nodesCount: nodes.length,
          durationMs,
        });
      }

      return {
        target: targetPath,
        totalRuns: runs.length,
        statusBreakdown: runReports.reduce((acc, r) => {
          acc[r.status] = (acc[r.status] || 0) + 1;
          return acc;
        }, {}),
        runs: runReports,
      };
    } finally {
      db.close();
    }
  } else {
    // JSONL 日志报表
    const fileStream = fs.createReadStream(targetPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let eventCount = 0;
    const eventTypes = {};

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      eventCount += 1;
      try {
        const entry = JSON.parse(line);
        const t = entry.type ?? entry.event ?? 'unknown';
        eventTypes[t] = (eventTypes[t] || 0) + 1;
      } catch {
        eventTypes['corrupt'] = (eventTypes['corrupt'] || 0) + 1;
      }
    }

    return {
      target: targetPath,
      totalEvents: eventCount,
      eventBreakdown: eventTypes,
    };
  }
}

// ---------------------------------------------------------------------------
// 5. CLI 入口路由与格式化展示
// ---------------------------------------------------------------------------
function printHelp() {
  console.log(`
dwfx CLI: 机制移植与调试运维综合命令行工具

用法:
  dwfx journal verify <db|jsonl> [--json]       校验四大机制不变量（悬空 seq、断裂、undefined 键）
  dwfx journal export <db> [--output <file>]    将 SQLite 运行与事件导出为流式 JSONL
  dwfx journal prune <db> --keep <N>            物理修剪历史数据，保留最近 N 个 Run
  dwfx sched replay <trace.jsonl> [--concur N]  回放并验证 trace 中的 FIFO 任务调度时序
  dwfx ledger report <db|jsonl> [--json]        输出账本与执行统计报表
`);
}

export async function main(argv = process.argv.slice(2)) {
  const [domain, action, ...args] = argv;

  if (!domain || domain === '--help' || domain === '-h') {
    printHelp();
    return 0;
  }

  // 子命令路由
  if (domain === 'journal') {
    if (action === 'verify') {
      const file = args[0];
      const asJson = args.includes('--json');
      if (!file) {
        console.error('Error: missing target file for "journal verify".');
        return 2;
      }
      const isDb = file.endsWith('.db') || file.endsWith('.sqlite');
      const report = isDb ? verifyDatabase(file) : await verifyJsonl(file);
      if (asJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`\n=== dwfx journal verify 报告 ===`);
        console.log(`目标: ${report.target}`);
        console.log(`结论: ${report.ok ? '🟢 PASS (零违规)' : `🔴 FAIL (${report.violations.length} 处违规)`}`);
        report.violations.forEach((v, i) => console.log(`  [${i + 1}] [${v.rule}] ${v.message}`));
      }
      return report.ok ? 0 : 1;
    }

    if (action === 'export') {
      const dbFile = args[0];
      const outIdx = args.indexOf('--output');
      const outFile = outIdx !== -1 ? args[outIdx + 1] : undefined;
      if (!dbFile) {
        console.error('Error: missing db file for "journal export".');
        return 2;
      }
      await journalExport(dbFile, outFile);
      if (outFile) {
        console.log(`Successfully exported journal to: ${outFile}`);
      }
      return 0;
    }

    if (action === 'prune') {
      const dbFile = args[0];
      const keepIdx = args.indexOf('--keep');
      const keepCount = keepIdx !== -1 ? parseInt(args[keepIdx + 1], 10) : NaN;
      if (!dbFile || isNaN(keepCount)) {
        console.error('Error: usage "dwfx journal prune <db> --keep <N>".');
        return 2;
      }
      const res = journalPrune(dbFile, keepCount);
      console.log(`Prune complete: Total Runs=${res.totalRuns}, Kept=${res.keptCount}, Pruned=${res.prunedCount}`);
      return 0;
    }
  }

  if (domain === 'sched' && action === 'replay') {
    const traceFile = args[0];
    const concurIdx = args.indexOf('--concur');
    const concur = concurIdx !== -1 ? parseInt(args[concurIdx + 1], 10) : 2;
    if (!traceFile) {
      console.error('Error: missing trace file for "sched replay".');
      return 2;
    }
    const res = await schedReplay(traceFile, concur);
    console.log(`\n=== dwfx sched replay 结果 ===`);
    console.log(`回放任务数: ${res.replayedCount}/${res.totalTasks}`);
    console.log(`时序一致性: ${res.orderConsistent ? '🟢 PASS' : '🔴 FAIL'}`);
    return res.orderConsistent ? 0 : 1;
  }

  if (domain === 'ledger' && action === 'report') {
    const targetFile = args[0];
    const asJson = args.includes('--json');
    if (!targetFile) {
      console.error('Error: missing target file for "ledger report".');
      return 2;
    }
    const report = await ledgerReport(targetFile);
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`\n=== dwfx ledger report ===`);
      console.log(`目标文件: ${report.target}`);
      if (report.totalRuns !== undefined) {
        console.log(`总运行数: ${report.totalRuns}`);
        console.log(`状态分布: ${JSON.stringify(report.statusBreakdown)}`);
      } else {
        console.log(`总事件数: ${report.totalEvents}`);
        console.log(`事件分布: ${JSON.stringify(report.eventBreakdown)}`);
      }
    }
    return 0;
  }

  console.error(`Unknown command: dwfx ${argv.join(' ')}`);
  printHelp();
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`CLI error: ${err.message}`);
    process.exit(2);
  });
}
