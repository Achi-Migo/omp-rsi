# 工程上下文画像与证据驱动经验晋升 (Profiler & Evidence-Based Learning)

## 1. 零大文件扫描工程画像 (ContextProfiler)

### 1.1 设计背景与开销控制

为消除传统 Agent 启动时遍历整个代码仓库检索语法树所带来的高 CPU/IO 负载，`ContextProfiler`（位于 `packages/dwfx-core/src/profiler.ts`）采取**极简清单探测法**：
- **纯文件存在性检测**：仅调用 `fs.existsSync` 检查根目录关键清单文件（`package.json`, `tsconfig.json`, `AGENTS.md`, `Makefile`, `Cargo.toml`, `go.mod` 等）；
- **不扫描大文件**：杜绝全量代码扫描、不构建 AST、不递归深度遍历目录；
- **毫秒级产出**：执行耗时 $< 5\text{ ms}$。

### 1.2 画像数据结构与推断规则

```typescript
export interface ContextProfile {
  language: 'typescript' | 'javascript' | 'rust' | 'go' | 'python' | 'unknown';
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'cargo' | 'go' | 'pip' | 'unknown';
  buildCmd?: string;
  testCmd?: string;
  typecheckCmd?: string;
  hasTypescript: boolean;
  capabilities: string[];
}
```

- **存在性推断，零文件读取**：命令推断只依赖清单/锁文件的存在性组合（如检测到 `package.json` + 锁文件即推断包管理器并拼装 `npm test`、`npm run typecheck` 等命令），**从不打开或解析 `package.json` 的 `scripts` 字段**——推断的是约定俗成的标准脚本名，而非读取仓库自定义脚本；
- **宿主注入与交互**：
  - `before_agent_start` 钩子将画像格式化为 Markdown 提示块，无感注入模型初始上下文；
  - 开发者或调试人员在终端输入 `/profiler` 指令时，钩子立即拦截并返回当前工程画像，无须耗费模型 Token。

---

## 2. 传统硬编码学习的反模式淘汰

旧版自进化钩子存在两大严重设计缺陷，本方案已予以彻底清理：

1. **会话压缩期重度阻塞**：旧逻辑在 `session_before_compact` 期间同步触发重型测试与编译套件，导致交互界面假死乃至因超时崩溃；
2. **硬编码文本伪造经验**：旧逻辑将固定文本（如 `openrsi-distilled-stability`）强行灌入记忆文件，缺乏真实测试转绿的客观依据支持。

**新版准则**：
- 废弃 `session_before_compact` 时的测试行为；
- 学习逻辑只挂载在终局 `agent_end`（且 `isTerminal !== false`）；
- 任何晋升必须以 SQLite `rsi_task` 中真实记录的 `status === 'succeeded'` 为唯一事实源。

---

## 3. 两级证据驱动自动晋升机制

```
[Agent 终局 agent_end (isTerminal)]
                 │
                 ▼
[读取 SQLite rsi_task 验证事实] ─── 任务未成功 (failed/running)? ──► 终止，拒绝晋升
                 │
                 ├── 检查 staging_tool_path 存在且合规
                 ▼
[一级晋升: 暂存工具晋升]
.omp/staging-tools/my-tool.ts ──► .omp/tools/my-tool.ts
(并在 SQLite 记录 promoted_tool_path)
                 │
                 ├── 统计该 skillName 在 rsi_task 中独立通过次数
                 ▼
[二级晋升: 常驻技能管理]
同名技能在不同任务中累计通过 >= 3 次?
                 │
                 ├── 是 ──► 调用 manage_skill({ action: 'create', ... })
                 │          落盘至 ~/.omp/agent/managed-skills/<name>/SKILL.md
                 └── 否 ──► 暂不升级，避免 Prompt 膨胀
```

### 3.1 一级晋升：暂存工具自动落盘

- **作用域**：任务执行过程中自主编写或沉淀的高频脚本（位于 `.omp/staging-tools/<name>.ts`）；
- **门禁要求**：该任务必须已决出 Champion 并通过全量门禁，在 SQLite 中记录为 `succeeded`；
- **晋升行为**：安全复制至 `.omp/tools/<name>.ts`，成为宿主原生可用工具，并回写 SQLite `promoted_tool_path` 字段。

### 3.2 二级晋升：三级常驻技能管理 (`manage_skill`)

- **跨任务验证硬指标**：相同的 `skillName` 必须在**至少 3 个完全不同的已通过任务**中被记录；
- **规范化调用**：符合阈值后，钩子触发 omp 标准 `manage_skill` 适配器：
  ```typescript
  await manage_skill({
    action: 'create',
    name: sanitizedSkillName,
    description: `Auto-promoted skill for ${sanitizedSkillName}`,
    body: skillBodyMarkdown,
  });
  ```
- **异常事务回滚**：创建技能目录与写入 `SKILL.md` 时采用独占写锁（`flag: 'wx'`）；若写入异常或中断，触发回滚清理，防止生成破损残片。
