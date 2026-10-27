# omp-rsi

omp 低资源自进化与高自治系统（RSI: Recursive Self-Improvement）工程技术文档库。

面向 **2 vCPU / 2 GiB RAM** 算力环境，提供无人工干预的自治研发回路、低开销串行多方案沙箱评估、确定性 Pareto 仲裁、动态工具自创、经验三级晋升与基于 SQLite 的客观事实持久化体系。

---

## 核心设计原则

1. **资源底线保全**：严格在 2 vCPU / 2 GiB 规格内运行，不引入重型编译、守护进程或外部数据库依赖；使用 `node:sqlite` 单连接 WAL 模式与 50 轮有限事实留存。
2. **确定性多维仲裁**：候选方案必须通过严格硬门禁（`exitCode === 0 && testPassRatio === 1`），再按变更文件数、代码行数、请求数、Token 数与耗时五维代价计算 Pareto 支配集，全序选择唯一 Champion。
3. **严格串行沙箱隔离**：全局评估并发度为 1，按仓库键（`repo:${cwd}`）FIFO 排队；支持临时 Git Worktree 及非 Git 目录的受控源码拷贝，补丁限制为 256 KiB / 20 文件以内。
4. **证据驱动而非假设**：杜绝在压缩期或每轮对话中同步执行重测试与硬编码经验；仅在任务终局（`agent_end`）读取 SQLite 已绿事实，触发真实可复用的工具与技能晋升。
5. **高自治与红线卡片化**：默认以 `omp --plan-yolo --auto-approve` 运行，规避日常计划与微观确认；仅在触发 CEO 6 类红线（死锁、大范围删除、高危破坏操作等）时挂起并调用交互卡片等待决策。

---

## 文档目录索引

| 文档路径 | 核心内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 系统总体架构、核心组件交互、状态机流转与时序图 |
| [docs/pareto-arbiter.md](docs/pareto-arbiter.md) | 纯函数进化引擎、Pareto 五维仲裁、Crossover 契约与死锁计数器隔离 |
| [docs/persistence.md](docs/persistence.md) | SQLite 双 Schema 设计、`RsiStore` 单连接 WAL 事务、FIFO 调度与客观指标算法 |
| [docs/sandbox-lifecycle.md](docs/sandbox-lifecycle.md) | 临时 Git Worktree 沙箱、非 Git 拷贝回退、补丁安全审计与 Champion 自动合并 |
| [docs/profiler-and-learning.md](docs/profiler-and-learning.md) | 零大文件扫描 `ContextProfiler`、`/profiler` 命令、工具注册与技能三级晋升 |
| [docs/operations-and-escalation.md](docs/operations-and-escalation.md) | 宿主配置、CLI 启动命令、6 类 CEO 红线拦截契约与排障排错指南 |

---

## 快速导航

- **启动自进化宿主**：
  ```bash
  omp --plan-yolo --auto-approve
  ```
- **查看当前工程画像**：
  ```bash
  /profiler
  ```
- **核心算子与宿主工具入口**：
  - 核心算子库：`packages/dwfx-core/src/evolution.ts`
  - 宿主工具集：`.omp/tools/evolution.ts`（暴露 `evolution_begin` 与 `evolution_record`）
  - 拦截与学习钩子：`.omp/hooks/pre/context-profiler.ts` 与 `.omp/hooks/pre/evolution-learner.ts`
  - 事实持久化层：`src/journal/rsi-store.ts`

---

## 作为 omp 插件安装与使用

### 1. 一键安装
```bash
omp plugin install omp-rsi
```
或通过软链接本地调试：
```bash
omp plugin link /path/to/omp-rsi
```

### 2. 插件核心能力
- **自进化工具注册**：在宿主中注册 `evolution_begin` 与 `evolution_record` 工具。
- **工程上下文感知**：启动前自动探测注入当前工程技术栈画像（`packageManager`、构建、测试、类型检查命令）。
- **终局经验客观沉淀**：任务成功终局自动提炼已验证工具至 `.omp/tools/`，高频技能晋升至 `.omp/agent/managed-skills/`。
- **状态检查命令**：在宿主交互中支持 `/rsi-status` 快速查看当前事实账本与候选方案指标。
