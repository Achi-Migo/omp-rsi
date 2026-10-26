# 运维配置、CEO 红线升级与排障指南 (Operations & Escalation)

## 1. 宿主配置与自治运行

### 1.1 配置文件规范 (`.omp/config.yml`)

为确保在低资源无人值守环境中顺畅执行，宿主必须配置以下核心参数：

```yaml
plan:
  enabled: true             # 开启自动化计划跟踪

tools:
  approvalMode: yolo         # 允许低风险读写与常规工具调用自动批准

ask:
  timeout: 0                # 关键：红线升级卡片无限期等待人工决策，超时不默认放行
```

### 1.2 命令行启动命令

常驻作业或批处理任务推荐启动命令：
```bash
omp --plan-yolo --auto-approve
```
- `--plan-yolo`：自动确认计划节点的展开与推进；
- `--auto-approve`：跳过常规安全级别工具调用的手工打字回车。

### 1.3 根目录类型安全约束 (`tsconfig.json`)

确保新增的算子与拦截钩子全部被主类型检查器捕获：
```json
{
  "include": [
    "src/**/*.ts",
    "assets/facade.d.ts",
    "packages/dwfx-core/src/**/*.ts",
    ".omp/hooks/**/*.ts",
    ".omp/tools/**/*.ts",
    "assets/omp-host.d.ts"
  ]
}
```

---

## 2. CEO 6 类红线升级契约 (CEO Red-Lines)

系统严格遵循「高自治推进，遇红线立刻挂起」原则。当命中以下 6 类场景时，绝对禁止自动做主，必须进入 `WAITING_AUTH` 状态并弹出交互卡片：

| 红线类别 | 触发条件 | 阻断动作与防护要求 |
|---|---|---|
| **1. 连续死锁 (Repair Deadlock)** | 同一错误特征（`normalizedErrorHash`）在同一任务内连续失败达 2 轮 | 立即中止自动盲修，保留当前 diff，报告确切阻断原因与候选比对 |
| **2. 破坏性文件删除** | 补丁或操作试图批量删除根目录文件、清空工作区或删除未提交代码 | 严格拦截文件物理移除，挂起等待授权 |
| **3. 安全凭证与网络泄漏** | 操作涉及泄漏 API Key、私钥、Token 或向未白名单域名推送数据 | 阻断外部写入并上报风险 |
| **4. 破坏性 Schema/契约破坏** | 算子试图变更持久化底层字段类型或废弃核心不变量 | 阻止迁移落地，上报不兼容影响评估 |
| **5. 状态不确定性 (UNKNOWN)** | 外部工具调用超时、中断或无明确返回状态 | 严禁盲目自动换参重试，必须先通过只读命令执行权威回查 |
| **6. 补丁边界越限** | 候选补丁超过 256 KiB、变更跨度超过 20 文件或检测到路径穿越 | 优雅拒绝候选打入，提示模型拆解任务或收敛改动范围 |

---

## 3. 决策交互卡片契约 (`ask` 卡片规范)

遇上述红线时，宿主与模型**严禁在消息正文中仅输出文字问句**让用户打字回复，必须调用 `ask` 工具生成终端交互卡片：

- **选项规格**：
  - 每次提供 2~4 个互斥、具有实质影响的方案选项；
  - 推荐选项置于首位并标注 `recommended: 0`；
  - 每个选项必须配置详细的 `description`，阐明该选择的利弊与潜在风险；
  - 严禁手动提供 "Other/其它" 选项（omp TUI 会自动在卡片末尾追加自定义手填框）。

---

## 4. 常见排障与环境维护指南

### 4.1 SQLite WAL 与文件锁维护

- **现象**：提示 `database is locked` 或 `busy`。
- **排查与修复**：
  1. 检查是否存在僵尸进程持有句柄：`lsof .omp/rsi.db`；
  2. 确认是否遵守单连接规范（同一时间只允许一个写事务）；
  3. 执行 WAL 检查点整理：
     ```bash
     sqlite3 .omp/rsi.db "PRAGMA wal_checkpoint(TRUNCATE);"
     ```

### 4.2 Git Worktree 残留清理

- **现象**：创建沙箱时提示 `worktree already exists` 或路径冲突。
- **排查与修复**：
  1. 检查是否有异常中断未被 finally 清理的沙箱：`git worktree list`；
  2. 执行清理修剪：
     ```bash
     git worktree prune
     ```
  3. 彻底删除临时目录：`rm -rf /tmp/rsi-cand-*`。

### 4.3 2 vCPU / 2 GiB 内存水位监控

- **现象**：Node 进程突然被系统 OOM Killer 终止（Exit 137）。
- **优化建议**：
  1. 确认已启用软链接 `node_modules`，未在沙箱内跑 `npm install`；
  2. 确认 `KeyedScheduler` 单并发运行正常，无并行沙箱同时跑门禁；
  3. 检查单候选补丁是否严格限制在 256 KiB 以内。
