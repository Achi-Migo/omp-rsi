# 系统架构设计 (Architecture)

## 1. 系统总体架构

omp 低资源自进化与高自治系统（omp-rsi）通过解耦「算子纯逻辑」、「持久化事实层」、「宿主调度控制器」与「终局学习钩子」，在极低硬件规格（2 vCPU / 2 GiB）下实现无人值守的闭环研发与代码自迭代。

系统分为四大层次：

1. **工程上下文画像层 (Context Profile Layer)**：
   - 基于清单文件存在性（`fs.existsSync`）快速判定宿主语言、包管理器及核心测试/构建命令；
   - 在 `before_agent_start` 钩子中静默注入会话，并对外暴露 `/profiler` 交互指令。
2. **纯函数进化引擎与仲裁层 (Pure Functional Evolution Core)**：
   - 包含变异（Draft）、故障调试（Debug）、杂交（Crossover）与硬门禁仲裁（Pareto Arbiter）；
   - 不依赖具体宿主环境，状态无外部副作用，支持确定性重放。
3. **宿主执行与沙箱生命周期层 (Host Controller & Sandbox Lifecycle)**：
   - 暴露 `evolution_begin` 与 `evolution_record` 工具；
   - 维护全局串行 FIFO 队列（按 `repo:${cwd}` 单并发约束）；
   - 创建隔离的 Git Worktree 或非 Git 临时代码副本，运行 `scripts/evolution-gate.mjs`；
   - 仲裁胜出后自动执行 `git apply`，将 Champion 补丁原子落盘。
4. **事实持久化与经验晋升层 (Persistence & RSI Promotion)**：
   - 基于 SQLite 单连接 WAL 模式保存任务事实（`rsi_task`）与候选方案（`rsi_candidate`）；
   - 保留最近 50 次已结算运行；
   - 在终局 `agent_end` 事件时拉取绿灯事实，自动晋升暂存工具（`.omp/staging-tools/` $\to$ `.omp/tools/`）与三级常驻技能（`manage_skill`）。

---

## 2. 核心组件交互与数据流

```
[Agent Session Start]
         │
         ▼
[ContextProfiler Hook] ──── 探测 manifest ────► 注入 ContextProfile (testCmd, buildCmd)
         │
         ▼
[evolution_begin Tool]
         │ (初始化 Run, 分配 runId, 在 SQLite 记录 rsi_task)
         ▼
[KeyedScheduler FIFO] ─── Concurrency = 1 (repo:${cwd})
         │
         ├───────────────────────────────┐
         ▼                               ▼
[Candidate 1: Draft]            [Candidate 2: Draft]
         │                               │
         │ (提交 diffPatch & SHA-256)   │
         ▼                               ▼
[Sandbox Lifecycle Manager]
         │
         ├── 1. 补丁安全检查 (<=256 KiB, <=20 文件, 路径穿越过滤)
         ├── 2. 创建独立 worktree 或拷贝源文件 (node_modules 软链接)
         ├── 3. 运行完整门禁: scripts/evolution-gate.mjs
         └── 4. 彻底清理沙箱目录
         │
         ▼
[evolution_record Tool] ─── 更新候选结果到 SQLite rsi_candidate
         │
         ▼
[状态机判断] ─── 未全绿且可调试? ──► [Candidate 3: Debug / Crossover]
         │ (最多追试 1 次)
         ▼
[ParetoArbiter]
         │
         ├── 硬门禁过滤 (exitCode === 0 && testPassRatio === 1)
         ├── 五维代价支配集剪枝
         └── 全序决出唯一 Champion
         │
         ▼
[Champion Merge] ─── git apply 原子落盘
         │
         ▼
[Task Settle] ─── 结算 SQLite 任务状态为 succeeded
         │
[Agent Session End]
         │
         ▼
[evolution-learner Hook]
         │
         ├── 检查 SQLite rsi_task 验证事实 (拒绝未绿产物)
         ├── 暂存工具晋升: .omp/staging-tools/*.ts ──► .omp/tools/*.ts
         └── 经验三级晋升: 相同技能累积 3 次独立验证 ──► manage_skill()
```

---

## 3. 核心接口与状态定义

### 3.1 候选算子与状态

- **算子类型 (EvolutionOperator)**：
  - `draft`：基于初始目标生成的基线候选方案。
  - `debug`：前序候选失败时，携带标准化错误特征（normalizedErrorHash）生成的修复方案。
  - `crossover`：两个互不冲突且全部跑通的父候选补丁的合并方案。
- **候选状态 (CandidateStatus)**：
  - `pending`：已创建，等待提交补丁或等待门禁评估。
  - `evaluating`：当前正处于沙箱隔离评估阶段。
  - `passed`：通过硬门禁（测试通过率 100% 且退出码为 0）。
  - `failed`：未通过门禁或补丁不合法被拒绝。
  - `dominated`：通过硬门禁但在 Pareto 多目标代价比较中被其他候选严格支配。
  - `champion`：最终选出并合并到主分支的最优候选。

### 3.2 任务生命周期状态

- `running`：任务开始，正在流转候选评估状态机。
- `succeeded`：仲裁决出 Champion 且补丁成功原子合入工作区。
- `failed`：所有候选均失败或触发连续死锁上限，任务挂起等待人工决策。
- `cancelled`：外部中断或任务被显式取消。
