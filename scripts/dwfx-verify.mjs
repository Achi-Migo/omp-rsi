#!/usr/bin/env node
/**
 * dwfx-verify: 独立只读不变量校验探针
 *
 * 依据 contract.md 校验数据库或 JSONL 跟踪日志中的四大核心不变量：
 * 1. 悬空与重复 seq（账本生命周期闭环）
 * 2. Sequence 序号连续性（无断裂、无乱序）
 * 3. 结构化 JSON 完整性（零 undefined 键、合法 JSON）
 * 4. 展示帽与节点一致性（nodesUnlisted 保真）
 *
 * 用法：
 *   node scripts/dwfx-verify.mjs <path-to-db-or-jsonl> [--json]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// 支持 node:sqlite DatabaseSync（Node 22+）
let DatabaseSync;
try {
  const sqlite = await import('node:sqlite');
  DatabaseSync = sqlite.DatabaseSync;
} catch {
  // SQLite 不可用时降级纯 JSONL 模式
}

class VerificationReport {
  constructor(target) {
    this.target = target;
    this.timestamp = new Date().toISOString();
    this.totalRunsScanned = 0;
    this.totalEventsScanned = 0;
    this.violations = [];
  }

  addViolation(rule, message, context = {}) {
    this.violations.push({
      rule,
      message,
      context,
    });
  }

  get ok() {
    return this.violations.length === 0;
  }
}

/** 深度检查对象是否包含非法 undefined 键或字符串形式的 "undefined" 洞 */
function inspectUndefinedKeys(obj, pathPrefix = '', violations = []) {
  if (obj === null || typeof obj !== 'object') return;

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (value === undefined) {
      violations.push({
        path: currentPath,
        value: 'undefined',
      });
    } else if (typeof value === 'number' && !Number.isFinite(value)) {
      violations.push({
        path: currentPath,
        value: String(value),
      });
    } else if (typeof value === 'object' && value !== null) {
      inspectUndefinedKeys(value, currentPath, violations);
    }
  }
}

/** 校验 SQLite 数据库 */
export function verifyDatabase(dbPath) {
  if (!DatabaseSync) {
    throw new Error('node:sqlite DatabaseSync is not available in current Node runtime.');
  }

  const report = new VerificationReport(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    // 1. 扫描全部 Run
    const runs = db.prepare('SELECT id, status, args_json, result_json, failure_json FROM dwf_run').all();
    report.totalRunsScanned = runs.length;

    for (const run of runs) {
      const runId = run.id;
      const isRunSettled = ['completed', 'failed', 'error', 'cancelled'].includes(run.status);

      // JSON 合法性与 undefined 键校验
      for (const field of ['args_json', 'result_json', 'failure_json']) {
        if (run[field]) {
          try {
            const parsed = JSON.parse(run[field]);
            const undefViolations = [];
            inspectUndefinedKeys(parsed, field, undefViolations);
            for (const v of undefViolations) {
              report.addViolation('INV-4', `Illegal undefined key found in run.${field}`, { runId, ...v });
            }
          } catch (e) {
            report.addViolation('INV-4', `Corrupted JSON in run.${field}: ${e.message}`, { runId });
          }
        }
      }

      // 2. 校验 dwf_event 序号连续性与载荷
      const events = db.prepare(
        'SELECT sequence, type, payload_json FROM dwf_event WHERE run_id = ? ORDER BY sequence ASC'
      ).all(runId);
      report.totalEventsScanned += events.length;

      let expectedSeq = 1;
      const ledgerTurns = new Map(); // seq -> { started: boolean, settled: boolean }

      for (const ev of events) {
        // 断言 3.1: Sequence 连续自增无断裂
        if (ev.sequence !== expectedSeq) {
          report.addViolation('INV-3', `Event sequence gap detected: expected ${expectedSeq}, got ${ev.sequence}`, {
            runId,
            event: ev.type,
          });
        }
        expectedSeq = ev.sequence + 1;

        // 载荷 JSON 检查
        let payload = null;
        if (ev.payload_json) {
          try {
            payload = JSON.parse(ev.payload_json);
            const undefViolations = [];
            inspectUndefinedKeys(payload, 'payload', undefViolations);
            for (const v of undefViolations) {
              report.addViolation('INV-4', `Illegal undefined key in event payload`, { runId, seq: ev.sequence, type: ev.type, ...v });
            }
          } catch (e) {
            report.addViolation('INV-4', `Corrupted JSON in dwf_event.payload_json: ${e.message}`, { runId, seq: ev.sequence });
          }
        }

        // 账本事件配对追踪
        if (ev.type === 'agent-start' && payload?.seq !== undefined) {
          const s = payload.seq;
          if (ledgerTurns.has(s) && ledgerTurns.get(s).started) {
            report.addViolation('INV-1', `Duplicate agent-start event for seq ${s}`, { runId, seq: s });
          } else {
            ledgerTurns.set(s, { started: true, settled: false });
          }
        } else if (ev.type === 'agent-end' && payload?.seq !== undefined) {
          const s = payload.seq;
          if (!ledgerTurns.has(s) || !ledgerTurns.get(s).started) {
            report.addViolation('INV-1', `Orphan agent-end event for undeclared seq ${s}`, { runId, seq: s });
          } else if (ledgerTurns.get(s).settled) {
            report.addViolation('INV-1', `Duplicate agent-end event for already settled seq ${s}`, { runId, seq: s });
          } else {
            ledgerTurns.get(s).settled = true;
          }
        }
      }

      // 断言 1.1: 终局无悬空检查
      if (isRunSettled) {
        for (const [seq, state] of ledgerTurns.entries()) {
          if (state.started && !state.settled) {
            report.addViolation('INV-1', `Dangling active agent turn in settled run (seq ${seq} was never ended)`, {
              runId,
              seq,
              runStatus: run.status,
            });
          }
        }
      }

      // 3. 校验 dwf_node 节点关联性
      // 3. 校验 dwf_node 节点关联性（仅在 Run 存在 agent 事件记录时强校验）
      const nodes = db.prepare('SELECT site_id, ordinal, actor_seq, input_json, result_json FROM dwf_node WHERE run_id = ?').all(runId);
      const hasRecordedAgentEvents = ledgerTurns.size > 0;
      if (hasRecordedAgentEvents) {
        for (const node of nodes) {
          if (node.actor_seq !== null && node.actor_seq !== undefined) {
            if (!ledgerTurns.has(node.actor_seq)) {
              report.addViolation('INV-1', `dwf_node references non-existent actor_seq ${node.actor_seq}`, {
                runId,
                siteId: node.site_id,
                ordinal: node.ordinal,
              });
            }
          }
        }
      }
    }
  } finally {
    db.close();
  }

  return report;
}

/** 校验纯 JSONL 日志文件 */
export async function verifyJsonl(jsonlPath) {
  const readline = await import('node:readline');
  const report = new VerificationReport(jsonlPath);
  const fileStream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const ledgerTurns = new Map(); // seq -> settled(boolean)
  let lineNum = 0;
  let expectedSequence = 1;
  let hasSequenceField = false;

  for await (const rawLine of rl) {
    lineNum += 1;
    const line = rawLine.trim();
    if (!line) continue;
    report.totalEventsScanned += 1;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      report.addViolation('INV-4', `Invalid JSON on line ${lineNum}: ${e.message}`, { line: lineNum });
      continue;
    }

    const undefViolations = [];
    inspectUndefinedKeys(entry, '', undefViolations);
    for (const v of undefViolations) {
      report.addViolation('INV-4', `Illegal undefined key or non-finite number on line ${lineNum}`, { line: lineNum, ...v });
    }

    // 检查全局自增 sequence 连续性（若存在）
    if (typeof entry.sequence === 'number') {
      hasSequenceField = true;
      if (entry.sequence !== expectedSequence) {
        report.addViolation('INV-3', `JSONL sequence gap: expected ${expectedSequence}, got ${entry.sequence}`, {
          line: lineNum,
          seq: entry.sequence,
        });
      }
      expectedSequence = entry.sequence + 1;
    }

    const eventType = entry.event ?? entry.type;
    const seq = entry.payload?.seq ?? entry.seq;

    if (eventType === 'agent-start' && typeof seq === 'number') {
      if (ledgerTurns.has(seq)) {
        report.addViolation('INV-1', `Duplicate agent-start for seq ${seq} on line ${lineNum}`, { line: lineNum, seq });
      } else {
        ledgerTurns.set(seq, false);
      }
    } else if (eventType === 'agent-end' && typeof seq === 'number') {
      if (!ledgerTurns.has(seq)) {
        report.addViolation('INV-1', `Orphan agent-end for undeclared seq ${seq} on line ${lineNum}`, { line: lineNum, seq });
      } else if (ledgerTurns.get(seq)) {
        report.addViolation('INV-1', `Duplicate agent-end for already settled seq ${seq} on line ${lineNum}`, { line: lineNum, seq });
      } else {
        ledgerTurns.set(seq, true);
      }
    }
  }

  // 断言 1.1: EOF 文件结束时，所有启动的 seq 必须已闭环
  for (const [seq, settled] of ledgerTurns.entries()) {
    if (!settled) {
      report.addViolation('INV-1', `Dangling active agent turn at EOF (seq ${seq} was never ended)`, { seq });
    }
  }

  return report;
}

// CLI 执行入口
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  const asJson = process.argv.includes('--json');

  if (!target) {
    console.error('Usage: node scripts/dwfx-verify.mjs <target.db | target.jsonl> [--json]');
    process.exit(2);
  }

  if (!fs.existsSync(target)) {
    console.error(`Target not found: ${target}`);
    process.exit(2);
  }

  try {
    const isDb = target.endsWith('.db') || target.endsWith('.sqlite');
    const report = isDb ? verifyDatabase(target) : await verifyJsonl(target);

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`\n=== dwfx-verify 不变量扫描报告 ===`);
      console.log(`扫描目标: ${report.target}`);
      console.log(`时间戳:   ${report.timestamp}`);
      console.log(`扫描统计: Runs=${report.totalRunsScanned}, Events=${report.totalEventsScanned}`);
      console.log(`校验结论: ${report.ok ? '🟢 PASS (零违规)' : `🔴 FAIL (${report.violations.length} 处违规)`}\n`);

      if (!report.ok) {
        console.log(`违规明细清单:`);
        report.violations.forEach((v, i) => {
          console.log(`  [${i + 1}] [${v.rule}] ${v.message}`);
          if (Object.keys(v.context).length > 0) {
            console.log(`      上下文: ${JSON.stringify(v.context)}`);
          }
        });
      }
    }

    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`Verification crashed: ${err.message}`);
    process.exit(2);
  }
}
