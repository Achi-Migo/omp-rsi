# SQLite 持久化与事实存储规范 (SQLite Persistence & Metrics)

## 1. 架构目标与资源边界

为在 2 vCPU / 2 GiB 环境下杜绝内存膨胀、文件句柄泄漏与高并发竞争，RSI 事实层采用 `node:sqlite` 原生轻量化驱动，遵循以下底层规范：
- **单连接模型**：每个 `RsiStore` 实例在生命周期内独占单一底层 Database 句柄，无连接池开销；
- **WAL 模式与性能**：执行 `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;`；
- **预编译复用**：所有高频操作（插入候选、更新门禁、序列号分配、指标聚合）均在打开时生成 PreparedStatement，避免 SQL 重复语法解析；
- **50 轮有限事实留存**：自动统计已完结任务（`status IN ('succeeded', 'failed', 'cancelled')`），超过 50 个已结算任务时触发级联修剪（Cascade Prune），修剪只在 `settleTask`（每轮一次）执行而非每笔写入，保证数据库常态大小在数兆字节以内。

---

## 2. 双 Schema 结构定义

持久化表结构在 `assets/journal-schema.sql`（纯 SQL 资产）与 `src/journal/schema.ts`（TypeScript 运行时契约）之间保持 100% 字节级一致。

### 2.1 任务表结构 (`rsi_task`)

记录宏观研发任务、目标、自治标识与晋升成果：

```sql
CREATE TABLE IF NOT EXISTS rsi_task (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  autonomous INTEGER NOT NULL DEFAULT 1 CHECK (autonomous IN (0, 1)),
  skill_name TEXT,
  skill_reused INTEGER NOT NULL DEFAULT 0 CHECK (skill_reused IN (0, 1)),
  skill_promoted INTEGER NOT NULL DEFAULT 0 CHECK (skill_promoted IN (0, 1)),
  staging_tool_path TEXT,
  promoted_tool_path TEXT,
  experience TEXT,
  champion_id TEXT,
  next_candidate_seq INTEGER NOT NULL DEFAULT 0,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  time_completed INTEGER
);
```

### 2.2 候选方案表结构 (`rsi_candidate`)

记录微观算子推演补丁、门禁度量及仲裁状态：

```sql
CREATE TABLE IF NOT EXISTS rsi_candidate (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES rsi_task(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('draft', 'improve', 'debug', 'crossover')),
  parent_ids_json TEXT NOT NULL,
  diff_patch TEXT NOT NULL,
  patch_hash TEXT,
  normalized_error_hash TEXT,
  exit_code INTEGER NOT NULL DEFAULT -1,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  test_pass_ratio REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'evaluating', 'passed', 'failed', 'deadlocked')),
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  UNIQUE(task_id, sequence)
);

CREATE INDEX IF NOT EXISTS rsi_candidate_task_idx ON rsi_candidate(task_id, sequence);
CREATE INDEX IF NOT EXISTS rsi_candidate_patch_hash_idx ON rsi_candidate(patch_hash);
```

`patch_hash`（补丁文本的 SHA-256）支撑 INV-1 幂等缓存：`evolution_record` 提交时先按哈希检索既有终态候选（`status IN ('passed', 'failed')`），命中则直接复用其门禁结论，跳过整个沙箱评估。

---

## 3. 事务性序号分配与防竞态

为保证单任务内候选方案时序严格连续，`RsiStore.createCandidate()` 在 SQLite 即时事务内执行计数器列自增并回读：

```sql
UPDATE rsi_task
SET next_candidate_seq = next_candidate_seq + 1, time_updated = ?
WHERE id = ? RETURNING next_candidate_seq;
```

在同一事务内完成编号获取与数据插入，彻底消除并发插入或重试带来的序号空洞与重复。

---

## 4. KeyedScheduler FIFO 串行调度器

宿主控制器（`.omp/tools/evolution.ts`）集成 `KeyedScheduler`，针对代码仓库施加单并发锁：

- **调度键 (Actor Key)**：`repo:${path.resolve(cwd)}`；
- **并发度上限**：默认 `maxConcurrency = 1`（INV-2 基线，2 vCPU 主机必须保持 1）；≥4 核宿主可通过 `EvolutionControllerOptions.evaluationConcurrency` 或环境变量 `RSI_EVAL_CONCURRENCY` 提升，此时各候选以 `repo:<cwd>:eval:<candidateId>` 细分键入队，在全局并发帽内并行评估；
- **队列语义**：默认同仓库的所有评估请求严格遵循先进先出（FIFO）队列排队，禁止并行争抢 CPU 编译或触发 Git 索引死锁（`index.lock`）。

---

## 5. 客观指标算法体系 (RSI Metrics)

系统通过 `RsiStore.metrics()` 提供纯 SQL 聚合计算出的客观进化度量，杜绝口头虚报或估算：

```sql
SELECT
  COUNT(*) AS task_count,
  AVG(CASE WHEN status = 'succeeded' THEN autonomous ELSE 0 END) AS autonomous_rate,
  AVG(CASE WHEN status = 'succeeded' THEN time_completed - time_created END) AS average_time_to_green_ms,
  COUNT(CASE WHEN staging_tool_path IS NOT NULL THEN 1 END) AS tool_attempt_count,
  COUNT(CASE WHEN promoted_tool_path IS NOT NULL THEN 1 END) AS tool_promoted_count,
  AVG(CASE WHEN skill_reused = 1 THEN 1.0 ELSE 0.0 END) AS skill_reuse_rate
FROM rsi_task;
```

| 指标字段 | 业务含义与计算公式 | 决策基线价值 |
|---|---|---|
| `autonomousRate` | **常规任务全自主率**：$\frac{\text{无需人工干预且成功绿灯的任务数}}{\text{总任务数}}$ | 评估模型摆脱人工干预的真实水平 |
| `averageTimeToGreenMs` | **平均转绿周期 (Time-to-Green)**：从任务启动到 Champion 合并的毫秒均值 | 评估进化迭代效率与沙箱收敛速度 |
| `toolGenerationSuccessRate` | **工具生成成功率**：$\frac{\text{成功晋升至 .omp/tools 的工具数}}{\text{暂存工具总尝试数}}$ | 评估自创动态工具的工程可靠性 |
| `skillReuseRate` | **技能复用率**：使用过往积累技能的任务占比 | 评估经验沉淀是否真实被后续任务激活 |
