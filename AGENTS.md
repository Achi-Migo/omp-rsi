# omp-rsi Agent Operational Specification

## 1. Role & Operational Environment

`omp-rsi` is a deterministic Recursive Self-Improvement (RSI) engine tailored specifically for the Open Multi-agent Platform (`omp`).

- **Hardware & Compute Boundary**: Strictly constrained to **2 vCPU / 2 GiB RAM**.
- **Execution Paradigm**: Deterministic, zero-compilation, zero-heavy-daemon, fully automated development loop (`omp --plan-yolo --auto-approve`).
- **Core Strategy**: Multi-candidate serial evaluation in isolated worktree/copy sandboxes, deterministic 5D Pareto frontier arbitration, and SQLite-backed durable ledger recording.

---

## 2. Host Tool Contracts

The host exposes two primary evolution tools registered in `.omp/tools/evolution.ts`:

### 2.1 `evolution_begin`
Initiates a new evolution run or tasks a lightweight sub-agent (`smol`) to explore a candidate branch.

- **Parameters**:
  - `taskId` *(string, optional)*: Unique identifier for the evolution task. Defaults to a UUID.
  - `objective` *(string, required)*: Specific engineering optimization or feature goal.
  - `skillName` *(string, optional)*: Skill utilized during this run for traceability.
  - `skillReused` *(boolean, optional)*: Flag indicating whether an existing skill was reused.
  - `stagingToolPath` *(string, optional)*: Path to an auto-created or staged custom tool script.
- **Return Action State Machine**:
  - Returns `EvolutionAction`:
    - `state: 'awaiting_candidate'`: Run registered; ready for candidate evaluation.
    - `runId`: Active run identifier.
    - `actorKey`: Concurrency queue key (always `repo:${cwd}`).
    - `role: 'smol'`: Role designation for delegated candidate generators.
    - `taskPrompt`: Structured prompt instructions for the sub-agent.

### 2.2 `evolution_record`
Submits a generated candidate patch for isolated sandbox evaluation, executes validation suites, computes Pareto domination against past candidates, and merges the Champion candidate if it passes all hard gates.

- **Parameters**:
  - `runId` *(string, required)*: Active run identifier created by `evolution_begin`.
  - `candidateId` *(string, required)*: Identifier for the candidate variant (e.g. `cand_a`, `cand_b`).
  - `diffPatch` *(string, required)*: Unified diff patch text. Maximum size: 256 KiB (`MAX_PATCH_BYTES`), maximum changed files: 20 (`MAX_CHANGED_FILES`).
  - `patchHash` *(string, required)*: Exact SHA-256 hex digest of the UTF-8 `diffPatch`.
  - `experience` *(string, optional)*: Concise reflection or lesson learned.
  - `requestCount` *(number, optional)*: LLM calls consumed by the candidate.
  - `tokenCount` *(number, optional)*: Estimated tokens consumed.
- **Return Action State Machine**:
  - Returns `EvolutionAction`:
    - `state: 'completed'`: Candidate evaluated, gates passed, and Champion merged atomically to the main workspace.
    - `state: 'rejected'`: Candidate failed hard gates (test failure, non-zero exit code) or was strictly dominated.
    - `state: 'escalated'`: Deadlock reached (3 consecutive failures) or security violation triggered (file/patch limits exceeded).
    - `champion`: Details of the accepted winner (`id`, `patchHash`, `changedFiles`, `changedLines`, `durationMs`).
    - `frontier`: IDs of the current Pareto non-dominated set.
    - `applied`: Boolean indicating whether the patch was applied to the main workspace.

---

## 3. Host Commands & Lifecycle Hooks

### 3.1 Commands
- `/profiler`: Invokes `ContextProfiler` to inspect project manifest metadata (language, package manager, detected build/test/typecheck commands, and capabilities) without walking large directory trees.

### 3.2 Hooks (`.omp/hooks/pre/`)
- `before_agent_start` (`context-profiler.ts`): Automatically inspects project root files (`package.json`, `tsconfig.json`, etc.) and injects ambient project capabilities into the agent context.
- `agent_end` (`evolution-learner.ts`): Terminal evidence promotion hook. Only after the task reaches a verified conclusion does it read SQLite ledger facts (`test_pass_ratio = 1.0 && exit_code = 0`), promoting proven tools to `.omp/tools/` and durable workflows to `.omp/agent/managed-skills/<name>/SKILL.md`.

---

## 4. Hard Invariants (INV-1 ~ INV-4)

Every agent and tool implementation MUST preserve these four invariants:

| Invariant | Name | Guarantee & Enforcement |
|---|---|---|
| **INV-1** | **Ledger Idempotent Pairing & Monotonic Finality** | In the SQLite store (`RsiStore`), every `(run_id, candidate_id)` pair is unique. Once an outcome is marked `verified` or `terminal`, state transitions are monotonic and immutable. Redundant evaluations of identical `patchHash` return cached results. |
| **INV-2** | **Serial FIFO Scheduling with Global Cap** | All evaluations lock on key `repo:${cwd}` via `KeyedScheduler`. Concurrency limit is strictly `1`. Candidates are evaluated in deterministic FIFO order to prevent CPU and I/O thrashing on 2 vCPU machines. |
| **INV-3** | **Append-Only Journal Single-Pass Projection** | Evolution history is stored in an append-only ledger (`evolution_records`). Materialized views and statistics are computed via single-pass streaming projections over the last 50 bounded runs. |
| **INV-4** | **Lossless JSON & FNV-1a Error Debouncing** | JSON payload metadata is serialized and deserialized losslessly. Validation failures compute an FNV-1a 32-bit hash on normalized error messages, suppressing repetitive failure logs and terminating infinite failure loops after 3 strikes. |

---

## 5. Standard Engineering & Maintenance Commands

Agents operating in this repository must use these standard npm/CLI commands:

- **One-Click Bootstrap & Health Check**:
  ```bash
  npm run bootstrap
  # or ./scripts/bootstrap.sh
  ```
- **Type Checking (Zero Emit)**:
  ```bash
  npm run typecheck
  ```
- **Full Test Suite (6 test suites, 30 tests)**:
  ```bash
  npm test
  ```
- **Sandbox Hard Gate & Smoke Check**:
  ```bash
  npm run gate
  # or node scripts/evolution-gate.mjs --target=all
  ```
- **Direct CLI Invocation**:
  ```bash
  node packages/dwfx-core/src/cli.ts profile
  node packages/dwfx-core/src/cli.ts evaluate --cwd=.
  ```
