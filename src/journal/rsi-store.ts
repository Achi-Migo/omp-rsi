import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { initSchema } from './schema.ts'

export type RsiTaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
export type RsiCandidateStatus = 'pending' | 'evaluating' | 'passed' | 'failed' | 'deadlocked'
export type RsiOperator = 'draft' | 'improve' | 'debug' | 'crossover'

export interface RsiTaskInput {
  id: string
  cwd: string
  objective: string
  autonomous?: boolean
  skillName?: string
  skillReused?: boolean
  stagingToolPath?: string
}

export interface RsiTaskRecord {
  id: string
  cwd: string
  objective: string
  status: RsiTaskStatus
  autonomous: boolean
  skillName?: string
  skillReused: boolean
  skillPromoted: boolean
  stagingToolPath?: string
  promotedToolPath?: string
  experience?: string
  championId?: string
  nextCandidateSeq: number
  timeCreated: number
  timeUpdated: number
  timeCompleted?: number
}

export interface RsiCandidateInput {
  id: string
  operator: RsiOperator
  parentIds: string[]
  diffPatch: string
  patchHash?: string
  normalizedErrorHash?: string
  exitCode?: number
  durationMs?: number
  testPassRatio?: number
  status?: RsiCandidateStatus
}

export interface RsiCandidateRecord {
  id: string
  taskId: string
  sequence: number
  operator: RsiOperator
  parentIds: string[]
  diffPatch: string
  patchHash?: string
  normalizedErrorHash?: string
  exitCode: number
  durationMs: number
  testPassRatio: number
  status: RsiCandidateStatus
  timeCreated: number
  timeUpdated: number
}

export interface CachedEvaluation {
  status: 'passed' | 'failed'
  exitCode: number
  durationMs: number
  testPassRatio: number
}

export interface RsiEvaluation {
  normalizedErrorHash?: string
  exitCode: number
  durationMs: number
  testPassRatio: number
  status: Exclude<RsiCandidateStatus, 'pending' | 'evaluating'>
}

export interface RsiMetrics {
  taskCount: number
  autonomousRate: number | null
  averageTimeToGreenMs: number | null
  toolGenerationSuccessRate: number | null
  skillReuseRate: number | null
  candidateCount: number
  passedCandidateCount: number
}

interface TaskRow {
  id: string
  cwd: string
  objective: string
  status: RsiTaskStatus
  autonomous: number
  skill_name: string | null
  skill_reused: number
  skill_promoted: number
  staging_tool_path: string | null
  promoted_tool_path: string | null
  experience: string | null
  champion_id: string | null
  next_candidate_seq: number
  time_created: number
  time_updated: number
  time_completed: number | null
}

interface CandidateRow {
  id: string
  task_id: string
  sequence: number
  operator: RsiOperator
  parent_ids_json: string
  diff_patch: string
  patch_hash: string | null
  normalized_error_hash: string | null
  exit_code: number
  duration_ms: number
  test_pass_ratio: number
  status: RsiCandidateStatus
  time_created: number
  time_updated: number
}

export interface RsiStoreOptions {
  now?: () => number
  retainedRuns?: number
}

/** One SQLite connection, precompiled statements, and transaction-scoped sequences. */
export class RsiStore {
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly retainedRuns: number
  private readonly statements: Record<string, StatementSync>

  constructor(db: DatabaseSync, options: RsiStoreOptions = {}) {
    this.db = db
    this.now = options.now ?? Date.now
    this.retainedRuns = options.retainedRuns ?? 50
    if (!Number.isInteger(this.retainedRuns) || this.retainedRuns < 1) {
      throw new Error(`retainedRuns must be a positive integer, got ${this.retainedRuns}`)
    }
    this.db.exec('pragma journal_mode = wal; pragma synchronous = normal; pragma foreign_keys = on;')
    initSchema(this.db)
    this.statements = Object.fromEntries(
      Object.entries({
        insertTask: `insert into rsi_task (
          id, cwd, objective, status, autonomous, skill_name, skill_reused,
          staging_tool_path, time_created, time_updated
        ) values (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
        getTask: 'select * from rsi_task where id = ?',
        nextCandidate: `update rsi_task
          set next_candidate_seq = next_candidate_seq + 1, time_updated = ?
          where id = ? returning next_candidate_seq`,
        insertCandidate: `insert into rsi_candidate (
          id, task_id, sequence, operator, parent_ids_json, diff_patch, patch_hash,
          normalized_error_hash, exit_code, duration_ms, test_pass_ratio,
          status, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        getCandidate: 'select * from rsi_candidate where id = ?',
        listCandidates: 'select * from rsi_candidate where task_id = ? order by sequence',
        updatePatch: 'update rsi_candidate set diff_patch = ?, patch_hash = ?, time_updated = ? where id = ?',
        findCachedEvaluation: `select status, exit_code, duration_ms, test_pass_ratio
          from rsi_candidate where patch_hash = ? and status in ('passed', 'failed')
          order by time_updated desc, id desc limit 1`,
        setEvaluating: `update rsi_candidate
          set status = 'evaluating', time_updated = ? where id = ? and status = 'pending'`,
        recordEvaluation: `update rsi_candidate set
          normalized_error_hash = ?, exit_code = ?, duration_ms = ?,
          test_pass_ratio = ?, status = ?, time_updated = ? where id = ?`,
        settleTask: `update rsi_task set status = ?, champion_id = coalesce(?, champion_id),
          experience = coalesce(?, experience), time_updated = ?, time_completed = ? where id = ?`,
        prune: `delete from rsi_task where id in (
          select id from rsi_task where status <> 'running'
          order by time_created desc, id desc limit -1 offset ?
        )`,
        verifiedTasks: `select t.* from rsi_task t
          where t.status = 'succeeded' and exists (
            select 1 from rsi_candidate c
            where c.task_id = t.id and c.status = 'passed' and c.exit_code = 0 and c.test_pass_ratio = 1
          ) order by t.time_created, t.id`,
        promoteTool: `update rsi_task set promoted_tool_path = ?, time_updated = ?
          where id = ? and status = 'succeeded' and staging_tool_path is not null and exists (
            select 1 from rsi_candidate c
            where c.task_id = rsi_task.id and c.status = 'passed' and c.exit_code = 0 and c.test_pass_ratio = 1
          )`,
        claimableSkills: `select t.* from rsi_task t
          where t.skill_name = ? and t.status = 'succeeded' and t.skill_promoted = 0
            and t.experience is not null and exists (
              select 1 from rsi_candidate c
              where c.task_id = t.id and c.status = 'passed' and c.exit_code = 0 and c.test_pass_ratio = 1
            ) order by t.time_created, t.id`,
        claimSkill: `update rsi_task set skill_promoted = 1, time_updated = ?
          where skill_name = ? and status = 'succeeded' and skill_promoted = 0 and experience is not null`,
        releaseSkill: 'update rsi_task set skill_promoted = 0, time_updated = ? where skill_name = ?',
        metrics: `select
          count(*) as task_count,
          avg(case when status = 'succeeded' then autonomous else 0 end) as autonomous_rate,
          avg(case when status = 'succeeded' then time_completed - time_created end) as average_time_to_green_ms,
          count(case when staging_tool_path is not null then 1 end) as tool_attempt_count,
          count(case when promoted_tool_path is not null then 1 end) as tool_success_count,
          avg(skill_reused) as skill_reuse_rate
          from rsi_task`,
        candidateMetrics: `select count(*) as candidate_count,
          count(case when status = 'passed' and exit_code = 0 and test_pass_ratio = 1 then 1 end) as passed_count
          from rsi_candidate`,
      }).map(([key, sql]) => [key, this.db.prepare(sql)]),
    )
  }

  static open(dbPath: string, options: RsiStoreOptions = {}): RsiStore {
    mkdirSync(dirname(dbPath), { recursive: true })
    return new RsiStore(new DatabaseSync(dbPath), options)
  }

  close(): void {
    this.db.close()
  }

  createTask(input: RsiTaskInput): RsiTaskRecord {
    const now = this.now()
    return this.transaction(() => {
      this.statements.insertTask.run(
        input.id,
        input.cwd,
        input.objective,
        input.autonomous === false ? 0 : 1,
        input.skillName ?? null,
        input.skillReused ? 1 : 0,
        input.stagingToolPath ?? null,
        now,
        now,
      )
      return this.requireTask(input.id)
    })
  }

  getTask(id: string): RsiTaskRecord | undefined {
    const row = this.statements.getTask.get(id) as TaskRow | undefined
    return row ? mapTask(row) : undefined
  }

  createCandidate(taskId: string, input: RsiCandidateInput): RsiCandidateRecord {
    const now = this.now()
    return this.transaction(() => {
      const row = this.statements.nextCandidate.get(now, taskId) as { next_candidate_seq: number } | undefined
      if (!row) throw new Error(`RSI task ${taskId} not found`)
      this.statements.insertCandidate.run(
        input.id,
        taskId,
        row.next_candidate_seq,
        input.operator,
        JSON.stringify(input.parentIds),
        input.diffPatch,
        input.patchHash ?? null,
        input.normalizedErrorHash ?? null,
        input.exitCode ?? -1,
        input.durationMs ?? 0,
        input.testPassRatio ?? 0,
        input.status ?? 'pending',
        now,
        now,
      )
      return this.requireCandidate(input.id)
    })
  }

  getCandidate(id: string): RsiCandidateRecord | undefined {
    const row = this.statements.getCandidate.get(id) as CandidateRow | undefined
    return row ? mapCandidate(row) : undefined
  }

  listCandidates(taskId: string): RsiCandidateRecord[] {
    return (this.statements.listCandidates.all(taskId) as unknown as CandidateRow[]).map(mapCandidate)
  }

  updatePatch(candidateId: string, diffPatch: string, patchHash?: string): void {
    this.statements.updatePatch.run(diffPatch, patchHash ?? null, this.now(), candidateId)
  }

  /** INV-1: the newest terminal evaluation of an identical patch, if any. */
  findEvaluationByPatchHash(patchHash: string): CachedEvaluation | undefined {
    const row = this.statements.findCachedEvaluation.get(patchHash) as
      | { status: 'passed' | 'failed'; exit_code: number; duration_ms: number; test_pass_ratio: number }
      | undefined
    if (!row) return undefined
    return {
      status: row.status,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      testPassRatio: row.test_pass_ratio,
    }
  }

  setCandidateEvaluating(candidateId: string): void {
    this.statements.setEvaluating.run(this.now(), candidateId)
  }

  recordEvaluation(candidateId: string, evaluation: RsiEvaluation): RsiCandidateRecord {
    this.statements.recordEvaluation.run(
      evaluation.normalizedErrorHash ?? null,
      evaluation.exitCode,
      evaluation.durationMs,
      evaluation.testPassRatio,
      evaluation.status,
      this.now(),
      candidateId,
    )
    return this.requireCandidate(candidateId)
  }

  settleTask(
    taskId: string,
    status: Exclude<RsiTaskStatus, 'running'>,
    details: { championId?: string; experience?: string } = {},
  ): RsiTaskRecord {
    const now = this.now()
    return this.transaction(() => {
      this.statements.settleTask.run(status, details.championId ?? null, details.experience ?? null, now, now, taskId)
      // Retention prune runs once per settled run instead of inside every write;
      // the retainedRuns bound is enforced at run granularity, not per candidate.
      this.prune()
      return this.requireTask(taskId)
    })
  }

  listVerifiedTasks(): RsiTaskRecord[] {
    return (this.statements.verifiedTasks.all() as unknown as TaskRow[]).map(mapTask)
  }

  markToolPromoted(taskId: string, promotedToolPath: string): boolean {
    return Number(this.statements.promoteTool.run(promotedToolPath, this.now(), taskId).changes) === 1
  }

  /** Atomically claims at least three distinct, verified task records for one skill. */
  claimSkillPromotion(skillName: string): RsiTaskRecord[] | undefined {
    return this.transaction(() => {
      const rows = this.statements.claimableSkills.all(skillName) as unknown as TaskRow[]
      if (rows.length < 3) return undefined
      this.statements.claimSkill.run(this.now(), skillName)
      return rows.map(mapTask)
    })
  }

  releaseSkillPromotion(skillName: string): void {
    this.statements.releaseSkill.run(this.now(), skillName)
  }

  metrics(): RsiMetrics {
    const task = this.statements.metrics.get() as {
      task_count: number
      autonomous_rate: number | null
      average_time_to_green_ms: number | null
      tool_attempt_count: number
      tool_success_count: number
      skill_reuse_rate: number | null
    }
    const candidate = this.statements.candidateMetrics.get() as {
      candidate_count: number
      passed_count: number
    }
    return {
      taskCount: task.task_count,
      autonomousRate: task.autonomous_rate,
      averageTimeToGreenMs: task.average_time_to_green_ms,
      toolGenerationSuccessRate:
        task.tool_attempt_count === 0 ? null : task.tool_success_count / task.tool_attempt_count,
      skillReuseRate: task.skill_reuse_rate,
      candidateCount: candidate.candidate_count,
      passedCandidateCount: candidate.passed_count,
    }
  }

  private requireTask(id: string): RsiTaskRecord {
    const task = this.getTask(id)
    if (!task) throw new Error(`RSI task ${id} not found`)
    return task
  }

  private requireCandidate(id: string): RsiCandidateRecord {
    const candidate = this.getCandidate(id)
    if (!candidate) throw new Error(`RSI candidate ${id} not found`)
    return candidate
  }

  private prune(): void {
    this.statements.prune.run(this.retainedRuns)
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('begin immediate')
    try {
      const result = work()
      this.db.exec('commit')
      return result
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }
}

function mapTask(row: TaskRow): RsiTaskRecord {
  return {
    id: row.id,
    cwd: row.cwd,
    objective: row.objective,
    status: row.status,
    autonomous: row.autonomous === 1,
    skillName: row.skill_name ?? undefined,
    skillReused: row.skill_reused === 1,
    skillPromoted: row.skill_promoted === 1,
    stagingToolPath: row.staging_tool_path ?? undefined,
    promotedToolPath: row.promoted_tool_path ?? undefined,
    experience: row.experience ?? undefined,
    championId: row.champion_id ?? undefined,
    nextCandidateSeq: row.next_candidate_seq,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
    timeCompleted: row.time_completed ?? undefined,
  }
}

function mapCandidate(row: CandidateRow): RsiCandidateRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    operator: row.operator,
    parentIds: JSON.parse(row.parent_ids_json) as string[],
    diffPatch: row.diff_patch,
    patchHash: row.patch_hash ?? undefined,
    normalizedErrorHash: row.normalized_error_hash ?? undefined,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    testPassRatio: row.test_pass_ratio,
    status: row.status,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}
