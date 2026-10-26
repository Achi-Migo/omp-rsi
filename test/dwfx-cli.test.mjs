import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  journalExport,
  journalPrune,
  schedReplay,
  ledgerReport,
  main as cliMain,
} from '../scripts/dwfx.mjs';

const TEST_DB = '/tmp/dwfx-cli-test.db';
const EXPORT_JSONL = '/tmp/dwfx-cli-export.jsonl';

function setupFixtureDb() {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(EXPORT_JSONL)) fs.unlinkSync(EXPORT_JSONL);

  const db = new DatabaseSync(TEST_DB);
  const schema = fs.readFileSync('assets/journal-schema.sql', 'utf8');
  db.exec(schema);

  // 插入 3 个不同的 Run
  for (let i = 1; i <= 3; i += 1) {
    const runId = `run-${i}`;
    db.prepare(
      'INSERT INTO dwf_run (id, status, caps_max_concurrency, time_created, time_updated) VALUES (?, ?, ?, ?, ?)'
    ).run(runId, i === 3 ? 'failed' : 'completed', 4, 1000 * i, 2000 * i);

    db.prepare(
      'INSERT INTO dwf_event (run_id, sequence, type, payload_json, time_created) VALUES (?, ?, ?, ?, ?)'
    ).run(runId, 1, 'run-started', JSON.stringify({ runId }), 1001 * i);

    db.prepare(
      'INSERT INTO dwf_event (run_id, sequence, type, payload_json, time_created) VALUES (?, ?, ?, ?, ?)'
    ).run(runId, 2, 'node-queued', JSON.stringify({ siteId: `ask-${i}`, ordinal: 0, actor: `actor-${i}` }), 1002 * i);

    db.prepare(
      'INSERT INTO dwf_event (run_id, sequence, type, payload_json, time_created) VALUES (?, ?, ?, ?, ?)'
    ).run(runId, 3, 'run-settled', JSON.stringify({ status: i === 3 ? 'failed' : 'completed' }), 1003 * i);
  }

  db.close();
}

test('CLI: journal verify 子命令执行', async () => {
  setupFixtureDb();

  // 正常数据库应当退出码 0 (PASS)
  const code = await cliMain(['journal', 'verify', TEST_DB]);
  assert.equal(code, 0);
});

test('CLI: journal export 与流式 JSONL 导出', async () => {
  setupFixtureDb();

  await journalExport(TEST_DB, EXPORT_JSONL);
  assert.ok(fs.existsSync(EXPORT_JSONL));

  const content = fs.readFileSync(EXPORT_JSONL, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  // 3 runs * 1 run-record + 3 runs * 3 events = 12 条记录
  assert.equal(lines.length, 12);
  lines.forEach((line) => {
    assert.doesNotThrow(() => JSON.parse(line));
  });
});

test('CLI: sched replay 任务时序回放与一致性断言', async () => {
  setupFixtureDb();
  await journalExport(TEST_DB, EXPORT_JSONL);

  const res = await schedReplay(EXPORT_JSONL, 2);
  assert.equal(res.totalTasks, 3);
  assert.equal(res.replayedCount, 3);
  assert.equal(res.orderConsistent, true);
});

test('CLI: ledger report 统计报表生成', async () => {
  setupFixtureDb();

  // 数据库报表
  const dbReport = await ledgerReport(TEST_DB);
  assert.equal(dbReport.totalRuns, 3);
  assert.equal(dbReport.statusBreakdown.completed, 2);
  assert.equal(dbReport.statusBreakdown.failed, 1);

  // JSONL 报表
  await journalExport(TEST_DB, EXPORT_JSONL);
  const jsonlReport = await ledgerReport(EXPORT_JSONL);
  assert.equal(jsonlReport.totalEvents, 12);
  assert.equal(jsonlReport.eventBreakdown['run-record'], 3);
  assert.equal(jsonlReport.eventBreakdown['event-record'], 9);
});

test('CLI: journal prune 历史修剪与级联清理', () => {
  setupFixtureDb();

  // 保留最近 1 个 Run，清理 2 个 Run
  const res = journalPrune(TEST_DB, 1);
  assert.equal(res.totalRuns, 3);
  assert.equal(res.prunedCount, 2);
  assert.equal(res.keptCount, 1);

  const db = new DatabaseSync(TEST_DB, { readOnly: true });
  const remainingRuns = db.prepare('SELECT id FROM dwf_run').all();
  assert.equal(remainingRuns.length, 1);
  assert.equal(remainingRuns[0].id, 'run-3'); // 最近创建的保留

  const remainingEvents = db.prepare('SELECT id FROM dwf_event').all();
  assert.equal(remainingEvents.length, 3); // 仅剩 run-3 的 3 条事件
  db.close();

  // 清理临时文件
  fs.unlinkSync(TEST_DB);
  if (fs.existsSync(EXPORT_JSONL)) fs.unlinkSync(EXPORT_JSONL);
});
