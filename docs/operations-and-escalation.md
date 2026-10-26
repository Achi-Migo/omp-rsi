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

---

## 5. 性能调优与吞吐加速指南 (Performance Tuning)

### 5.1 耗时基线测量

任何优化前后都用同一把尺子量，不凭感觉：

```bash
npm run perf   # 输出 typecheck / 各测试套件 / 完整 gate 的逐项耗时 JSON
```

本仓库 2 vCPU 参考基线：typecheck ≈ 2.0s，完整 gate（typecheck + 6 套件单进程 `node --test`）≈ 4.8s。

### 5.2 已内置的加速机制（无需配置）

| 机制 | 作用 | 触发条件 |
|---|---|---|
| gate 失败快速短路 | typecheck 失败即跳过测试阶段，失败候选门禁成本约减半 | `--target=all` 且 typecheck 阶段失败 |
| patchHash 幂等缓存 (INV-1) | 相同补丁哈希直接复用终态结论，跳过整个沙箱 | 提交哈希在近 50 轮内已有 `passed`/`failed` 记录 |
| 交叉候选快速通道 | 双父代已过全量门的交叉候选只跑测试跳过 tsc | 交叉候选评估；冠军为快速通道候选时合并后补跑 typecheck 兜底 |
| 门禁进程组击杀 | 超时 SIGTERM → 5s 宽限 → SIGKILL 杀整棵进程树，杜绝孙进程 CPU 残留 | 任意子进程超时或中止 |
| bootstrap 单遍执行 | typecheck 与 30+ 测试各只跑一遍（原为两遍） | `npm run bootstrap` |

### 5.3 LLM 侧提速（端到端墙钟的最大变量）

沙箱门禁只占单轮进化本地 CPU 成本（3 候选 × ~5s）；smol 子代理生成 diff 的 LLM 延迟通常是端到端墙钟的大头：

- **smol 模型选型（本机已配置）**：smol 角色已设为 `agy/gemini-3.5-flash-lite`（1M 上下文轻量档）：

  ```bash
  # 持久化配置（全局，已生效，落盘 /root/.omp/agent/config.yml）
  omp config set modelRoles '{"web":"web/firecrawl","default":"agy/gemini-3.8-flash-high","smol":"agy/gemini-3.5-flash-lite"}'

  # 单次会话临时覆盖（优先于持久配置）
  omp --smol=gemini-3.5-flash-lite --plan-yolo --auto-approve
  PI_SMOL_MODEL=gemini-3.5-flash-lite omp --plan-yolo --auto-approve
  ```

  smol 只负责产 diff，质量兜底在确定性门禁，模型可以尽量激进地快。候选池见 `omp models list`（agy/ark 两家 provider）；选型可用 `omp bench` 实测 TTFT 与解码吞吐。若只想在本项目生效而不影响其他 omp 会话，可改用启动参数/环境变量，或将 `modelRoleStorage` 切为 `project`；

  > **运行时验证记录（omp 18.12.6）**：`modelRoles.smol = agy/gemini-3.5-flash-lite` 已配置并实测通过——`omp --model=@smol -p` 消息期角色解析正常回包（引擎 smol 子代理生成 diff 即此路径）。但 **`--plan-yolo` 启动期对 plan-yolo-into 的模型校验发生在扩展 provider 注册之前**，任何指向 agy 模型的 `--plan-yolo-into`（含经 @smol 间接解析）都会在启动时抛 `Model ... not found`；该问题与 smol 角色配置无关（未配置 smol 时 plan-yolo 同样无法完成启动）。规避方式：计划自动执行场景改用 `omp --auto-approve -p`（无 `--plan-yolo`）启动（已实测可完整执行任务，`retry.modelFallback` 会在模型故障时自动回退），或等待 omp 修复该启动时序问题。

  > **agy 网关模型实测健康清单（2026-10-26）**：claude-opus-4-6-thinking ✅ / claude-sonnet-4-6 ✅ / gemini-3-flash ✅ / **gemini-3.5-flash-lite ✅（smol 在用）** / gemini-3.1-flash-lite ✅ / gpt-oss-120b-medium ✅ / gemini-3.1-flash-image（未测，图像专用）/ **gemini-3.8-flash-high ⚠️ 网关侧正常、omp 侧 404（经 omp 调用稳定报 `404 status code (no body)`，靠 modelFallback 兜底；建议 default 角色切换到可用模型）**。
  >
  > **gemini-3.8-flash-high 404 根因结论（2026-10-26）**：网关与该模型本身完全正常——curl 直连 `https://hy.achimigo.top/v1` 实测 chat/completions 200、responses 流式 200、`/v1/models` 清单包含该模型。404 无 body 与"未知路径"指纹吻合（对照实验：网关对未知模型返回 400 + JSON body，对未知路径返回 404 + 空 body）。本地回显服务器对照实验证明 `models.json` 实时生效（改名的 gemini 变体请求正确打到本地 `POST /v1/chat/completions`），但将 gemini-3.8-flash-high 的 per-model baseUrl 指向本地回显后请求仍打真实网关错误路径——**omp 对该模型的请求解析无视了 models.json 中的 per-model baseUrl**，属 omp 侧（18.12.6）路径/baseUrl 解析缺陷，值得向 omp 上报。规避：default 角色改用实测可用模型（如 `agy/gemini-3-flash` 或 `agy/claude-sonnet-4-6`）。
- **prompt 约束收敛**：`evolution_begin` 返回的 `taskPrompt` 已限定 ≤20 文件 / ≤256 KiB / 禁止装依赖，避免 smol 生成超大补丁导致反复被拒；
- **请求预算**：`.omp/config.yml` 的 `task.maxConcurrency: 2`（双草稿并行生成）与 `softRequestBudget: 100` 已按低资源调优。

### 5.4 评估并发（仅限 ≥4 核宿主）

```bash
RSI_EVAL_CONCURRENCY=2 omp --plan-yolo --auto-approve
```

默认严格串行（INV-2 基线，2 vCPU 必须保持 1）。提升后各候选以 `repo:<cwd>:eval:<candidateId>` 细分键并行入队；注意每个并行门禁约占 400~600 MiB 内存，2 GiB 机器严禁开启。
