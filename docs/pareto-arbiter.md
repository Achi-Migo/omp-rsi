# Pareto 仲裁器与自进化核心引擎 (Pareto Arbiter & Evolution Core)

## 1. 纯函数设计理念

`packages/dwfx-core/src/evolution.ts` 实现为完全解耦宿主环境的纯算子引擎。所有候选生成、状态转移、错误标准化与最优解仲裁均由确定性算法驱动，具备以下核心特性：
- **无状态重放**：不持有全局单例连接，依赖外部传入的参数与账本接口驱动；
- **确定性判定**：在相同输入、相同测试结果与补丁内容下，仲裁结果恒定一致；
- **内存零溢出**：对大型中间结构进行即时剪枝，适配 2 GiB 内存约束。

---

## 2. 候选硬门禁与五维 Pareto 代价模型

### 2.1 硬门禁准入 (Hard Gate)

任何进入仲裁阶段的候选方案，必须**无条件**满足硬门禁准入线：
```typescript
candidate.exitCode === 0 && candidate.testPassRatio === 1
```
凡未达到退出码为 0 或测试用例通过率不足 100% 的候选，直接判定为 `failed`，不参与任何代价值比较与仲裁排序。

### 2.2 五维最小化代价向量

对于通过硬门禁的所有候选解，仲裁器提取其五维资源消耗度量：
$$\vec{C}(s) = \Big( \text{changedFiles},\; \text{changedLines},\; \text{requestCount},\; \text{tokenCount},\; \text{durationMs} \Big)$$

其中：
- `changedFiles`：补丁涉及修改、新增或删除的文件数量；
- `changedLines`：变更总行数（`additions + deletions`）；
- `requestCount`：方案产出期间消耗的子调用轮次；
- `tokenCount`：推演该方案消耗的模型 Token 计数；
- `durationMs`：沙箱门禁测试实际耗时（毫秒）。

### 2.3 支配关系判定 (Pareto Dominance)

设候选方案 $A$ 与 $B$ 的代价向量分别为 $\vec{C}(A)$ 与 $\vec{C}(B)$。
定义 **$A$ 支配 $B$**（记作 $A \succ B$）当且仅当：
$$\forall i \in \{1..5\},\; C_i(A) \le C_i(B) \quad \land \quad \exists j \in \{1..5\},\; C_j(A) < C_j(B)$$

- 若存在任何其他已过门禁候选 $A$ 使得 $A \succ B$，则候选 $B$ 被标记为 `dominated`，从 Pareto 前沿面剔除；
- 保留在 Pareto 前沿上的互不支配解集合构成前沿候选集 $\mathcal{P}$。

### 2.4 全序 Champion 决胜排序 (Deterministic Tie-Breaker)

当 Pareto 前沿存在多个互不支配解时，仲裁器按照预定义的绝对优先级全序进行级联决胜，选出唯一 Champion：

1. **`changedFiles` 升序**：最小化改动文件跨度，抑制大范围侵入；
2. **`changedLines` 升序**：最小化修改行数，优先最精简有效补丁；
3. **`tokenCount` 升序**：最小化认知消耗与模型预算；
4. **`durationMs` 升序**：最小化运行与验证时间；
5. **`patchHash` 字典序升序**：兜底确定性哈希决胜，杜绝由于候选插入先后顺序导致的偶发不确定性。

---

## 3. Crossover（杂交算子）硬契约

为避免方案盲目拼接引入不可排查的语法错误或行为冲突，`crossover()` 算子施加了三条硬性不变量约束：

1. **同基线约束 (Same Baseline)**：
   两个父候选必须基于同一任务的基线版本衍生，禁止跨任务或跨基线杂交。
2. **父本全绿约束 (Passing Parents)**：
   参与杂交的父候选必须**均已通过全量门禁**（`status === 'passed'`）。禁止对失败方案、草稿方案或未测试方案执行杂交。
3. **文件集不相交约束 (Disjoint Changed Files)**：
   通过 `inspectPatch(diffPatch)` 分析两个父候选涉及的文件集合：
   $$\text{Files}(P_1) \cap \text{Files}(P_2) = \emptyset$$
   若存在哪怕一个重叠文件，杂交操作立即中止并不产生新候选，避免文本冲突。
4. **强制重新门禁 (Mandatory Re-gating)**：
   杂交产出的新候选其初始状态必须为 `pending`。**严禁直接将拼接补丁判定为 Champion**，必须完整送入沙箱执行 `scripts/evolution-gate.mjs` 测试，通过后方可参与 Pareto 仲裁。

---

## 4. 任务级死锁隔离与错误标准化

### 4.1 错误特征归一化 (Error Normalization)

当候选失败时，原生堆栈包含不稳定的绝对路径、临时随机数、PID 或毫秒时间戳。引擎提取核心报错特征进行脱敏洗净：
- 抹除文件物理路径（如 `/tmp/rsi-sand-12345/`）；
- 抹除行号与列号抖动；
- 提取错误类型（`ErrorType`）与首行特征摘要；
- 计算 32 位 FNV-1a 哈希并输出标准 8 字符十六进制串 `normalizedErrorHash`。

### 4.2 死锁计数器任务隔离

防止全局连续失败计数污染独立任务：
- **隔离键结构**：`${taskId}:${normalizedErrorHash}`；
- **计数策略**：同一任务针对同一特征错误重试时递增计数；若该任务下有任意候选成功转绿，**立即销毁并重置该任务关联的全部错误计数器**；
- **红线阈值**：当特定错误特征在同一任务内连续出现达到 2 轮时，拒绝无休止盲目重试，将错误标记为 `REPAIR_LOOP_DEADLOCK`，流转至宿主触发 CEO 仲裁卡片。
