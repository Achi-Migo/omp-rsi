/**
 * Five-table journal DDL, transcribed from assets/journal-schema.sql (ZCode dwf_* tables).
 * 拍板表#16：约束对齐 DDL 原文，不放松——dwf_run 三约束 / dwf_event payload_json not null /
 * session_task_link 的 NOT NULL 列与 unique(child_session_id) / dwf_run_cwd_idx 与
 * dwf_event_artifact_idx 两索引全部补回；`if not exists` 幂等化保留（语义等价）；
 * 指向五表外实体（workflow_run / workflow_activity / session）的外键以注释保留——
 * MVP 空表不接线，接入真实宿主时按原文恢复。
 */

import type { DatabaseSync } from 'node:sqlite'

const DDL = `
create table if not exists dwf_run (
  id text primary key,
  parent_session_id text,
  cwd text,
  name text,
  script_text text,
  script_hash text,
  args_json text,
  tool_call_id text,
  resumed_from text,
  caps_max_concurrency integer not null,
  spent_tokens integer not null default 0,
  status text not null check(status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  result_json text,
  failure_json text,
  time_created integer not null,
  time_updated integer not null
);

create table if not exists dwf_actor (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  site_id text not null,
  ordinal integer not null,
  name text,
  persona_json text,
  resolved_model text,
  session_id text,
  time_created integer not null,
  time_updated integer not null,
  unique(run_id, site_id, ordinal)
);

create table if not exists dwf_node (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  site_id text not null,
  ordinal integer not null,
  kind text not null check(kind in ('ask', 'world-read', 'world-run', 'report', 'artifact')),
  actor_site_id text,
  actor_ordinal integer,
  actor_seq integer,
  input_hash text not null,
  input_json text,
  status text not null check(status in ('running', 'completed', 'failed')),
  result_json text,
  error_json text,
  stats_json text,
  message_boundary integer,
  artifact_id text,
  time_created integer not null,
  time_updated integer not null,
  unique(run_id, site_id, ordinal)
);

create table if not exists dwf_event (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  sequence integer not null,
  type text not null,
  payload_json text not null,
  time_created integer not null,
  unique(run_id, sequence)
);

create table if not exists session_task_link (
  id integer primary key autoincrement,
  root_workflow_run_id text, -- references workflow_run(id) on delete cascade（五表外，MVP 不接线）
  parent_link_id integer references session_task_link(id) on delete cascade,
  activity_id integer, -- references workflow_activity(id) on delete set null（五表外，MVP 不接线）
  parent_session_id text, -- references session(id) on delete set null（五表外，MVP 不接线）
  child_session_id text not null, -- references session(id) on delete cascade（五表外，MVP 不接线）
  role text not null,
  depth integer not null default 0,
  path text not null,
  phase text,
  label text,
  agent_type text,
  model text,
  status text not null,
  time_created integer not null,
  time_updated integer not null,
  unique(child_session_id)
);

create table if not exists rsi_task (
  id text primary key,
  cwd text not null,
  objective text not null,
  status text not null check(status in ('running', 'succeeded', 'failed', 'cancelled')),
  autonomous integer not null default 1 check(autonomous in (0, 1)),
  skill_name text,
  skill_reused integer not null default 0 check(skill_reused in (0, 1)),
  skill_promoted integer not null default 0 check(skill_promoted in (0, 1)),
  staging_tool_path text,
  promoted_tool_path text,
  experience text,
  champion_id text,
  next_candidate_seq integer not null default 0,
  time_created integer not null,
  time_updated integer not null,
  time_completed integer
);

create table if not exists rsi_candidate (
  id text primary key,
  task_id text not null references rsi_task(id) on delete cascade,
  sequence integer not null,
  operator text not null check(operator in ('draft', 'improve', 'debug', 'crossover')),
  parent_ids_json text not null,
  diff_patch text not null,
  patch_hash text,
  normalized_error_hash text,
  exit_code integer not null default -1,
  duration_ms integer not null default 0,
  test_pass_ratio real not null default 0,
  status text not null check(status in ('pending', 'evaluating', 'passed', 'failed', 'deadlocked')),
  time_created integer not null,
  time_updated integer not null,
  unique(task_id, sequence)
);

create index if not exists rsi_candidate_task_idx on rsi_candidate(task_id, sequence);
create index if not exists rsi_candidate_patch_hash_idx on rsi_candidate(patch_hash);
create index if not exists rsi_task_skill_idx on rsi_task(skill_name, status, skill_promoted);
create index if not exists dwf_node_run_idx on dwf_node(run_id);
create index if not exists dwf_node_artifact_idx on dwf_node(run_id, artifact_id);
create index if not exists dwf_event_run_idx on dwf_event(run_id);
create index if not exists dwf_actor_run_idx on dwf_actor(run_id);
create index if not exists dwf_run_cwd_idx on dwf_run(cwd, time_updated);
create index if not exists dwf_event_artifact_idx on dwf_event(run_id, json_extract(payload_json, '$.artifactId'), sequence);
`

export function initSchema(db: DatabaseSync): void {
  db.exec(DDL)
  // Databases created before patch_hash existed need a one-shot idempotent migration;
  // `create table if not exists` cannot extend an existing table.
  const columns = db.prepare("pragma table_info('rsi_candidate')").all() as unknown as { name: string }[]
  if (!columns.some((column) => column.name === 'patch_hash')) {
    db.exec('alter table rsi_candidate add column patch_hash text')
    db.exec('create index if not exists rsi_candidate_patch_hash_idx on rsi_candidate(patch_hash)')
  }
}
