# 沙箱生命周期与 Champion 原子合并 (Sandbox Lifecycle & Merge)

## 1. 沙箱隔离设计哲学

在 2 vCPU / 2 GiB 的资源受限环境下，传统的 Docker 容器或全量 VM 开销过大，容易引发 OOM。系统采用**轻量级文件系统隔离 + 原生进程调度**的双模沙箱机制：
- **零额外依赖安装**：软链接宿主现有的 `node_modules`，杜绝任何形式的在线 `npm install`；
- **微秒级创建与销毁**：借助 Git Worktree 或快速文件拷贝，沙箱启停耗时控制在数十毫秒内；
- **全生命周期无泄漏保证**：所有外部调用包裹在严格的 `try...finally` 块中，无论门禁通过、失败或崩溃，沙箱临时目录必须 100% 清理。

---

## 2. 双模隔离沙箱实现

```
                      [进入沙箱评估]
                            │
               ┌────────────┴────────────┐
               ▼                         ▼
        [Git 仓库环境]             [非 Git 目录]
               │                         │
     git worktree add          创建 /tmp/rsi-cand-*
               │                         │
    覆盖当前脏工作区改动       白名单拷贝受控源码子集
   (git diff HEAD 叠加)        + 软链接 node_modules
               │                         │
               └────────────┬────────────┘
                            │
                   [补丁安全门禁审计]
             (<=256 KiB, <=20 文件, 无穿越)
                            │
                      git apply 补丁
                            │
                执行 scripts/evolution-gate.mjs
                            │
                     解析 JSON 输出
                            │
                     [finally 强制清理]
              git worktree remove / fs.rm
```

### 2.1 主路径：Git Worktree 沙箱

在标准 Git 仓库中，优先使用 `git worktree`：

1. **快照创建**：执行 `git worktree add --detach <sandboxPath> HEAD`；
2. **脏工作区覆盖 (Dirty Overlay)**：通过 `git diff HEAD` 捕获宿主当前未提交的代码变更并注入 Worktree，确保候选补丁基于宿主真实的最新工作区状态执行测试；
3. **依赖共享**：软链接宿主 `node_modules` 到 `<sandboxPath>/node_modules`；
4. **补丁应用**：在沙箱内执行 `git apply` 打入当前候选的 `diffPatch`。

### 2.2 回退路径：非 Git 受控源码拷贝

若工作区脱离 Git 版本控制，系统自动平滑回退至文件级隔离：

1. **白名单拷贝**：快速同步工程清单（`package.json`, `tsconfig.json` 等）与主要代码目录（`src`, `packages`, `assets`, `scripts`）；
2. **补丁涉及文件靶向同步**：通过 `inspectPatch(diffPatch).changedFilePaths` 解析目标变更文件，校验并建立父目录，确保改动目标从宿主原样拷贝到沙箱；
3. **路径穿越防护**：严格断言所有文件解析后的真实路径必须位于沙箱根目录内（`resolvedPath.startsWith(sandboxPath)`），彻底拦截 `../` 等任意目录穿越攻击。

---

## 3. 补丁安全审计硬指标

在沙箱应用补丁前，宿主执行严格的边界守卫（Guard Rails），超出边界者优雅拒绝（返回 `failed` 且不崩溃）：

- **体积上限**：单候选统一补丁（Unified Diff）文本长度 $\le 256\text{ KiB}$（`262,144` 字节）；
- **文件跨度上限**：单补丁修改、新增或删除的文件数量 $\le 20$ 个；
- **哈希一致性检验**：提交的补丁文本 SHA-256 必须与提交参数严格匹配，防止中间篡改或截断。

---

## 4. 门禁脚本执行与结果解析

沙箱内执行受信任的真实门禁命令：
```bash
node scripts/evolution-gate.mjs --target=all
```
门禁执行进程设置独立超时（默认 120 秒），并将输出的标准 JSON 结构反序列化：
```json
{
  "ok": true,
  "target": "all",
  "totalStages": 4,
  "passedStages": 4,
  "passRatio": 1,
  "durationMs": 9804,
  "exitCode": 0,
  "errorHash": ""
}
```
并将以上数据结构完整同步回写入 SQLite `rsi_candidate` 记录中。

---

## 5. Champion 原子合并 (Atomic Champion Merge)

当 Pareto 仲裁决出最优 Champion 候选后，宿主自动执行主工作区落盘：

1. **预检 (Dry-Run Check)**：
   在宿主真实工作区执行：
   ```bash
   git apply --check <patch>
   ```
2. **原子合入**：
   预检通过后，立即执行真实落盘：
   ```bash
   git apply <patch>
   ```
3. **冲突阻断**：
   若因外部突发修改导致 `git apply --check` 失败，系统**严禁自行猜测或强制合入**，直接将任务状态标记为失败，并报告具体文件冲突，保护工作区完整性。
