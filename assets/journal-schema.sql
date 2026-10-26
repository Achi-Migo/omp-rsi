-- session_task_link
CREATE TABLE session_task_link (
        id text primary key,
        root_workflow_run_id text references workflow_run(id) on delete cascade,
        parent_link_id text references session_task_link(id) on delete cascade,
        activity_id text references workflow_activity(id) on delete set null,
        parent_session_id text references session(id) on delete set null,
        child_session_id text not null references session(id) on delete cascade,
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

-- dwf_run
CREATE TABLE dwf_run (
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
        status text not null check(status in (
          'pending',
          'running',
          'completed',
          'failed',
          'cancelled'
        )),
        result_json text,
        failure_json text,
        time_created integer not null,
        time_updated integer not null
      );

-- dwf_run_cwd_idx
CREATE INDEX dwf_run_cwd_idx on dwf_run(cwd, time_updated);

-- dwf_actor
CREATE TABLE dwf_actor (
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

-- dwf_actor_run_idx
CREATE INDEX dwf_actor_run_idx on dwf_actor(run_id);

-- dwf_node
CREATE TABLE dwf_node (
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

-- dwf_node_run_idx
CREATE INDEX dwf_node_run_idx on dwf_node(run_id);

-- dwf_node_artifact_idx
CREATE INDEX dwf_node_artifact_idx on dwf_node(run_id, artifact_id);

-- dwf_event
CREATE TABLE dwf_event (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        sequence integer not null,
        type text not null,
        payload_json text not null,
        time_created integer not null,
        unique(run_id, sequence)
      );

-- dwf_event_artifact_idx
CREATE INDEX dwf_event_artifact_idx
        on dwf_event(run_id, json_extract(payload_json, '$.artifactId'), sequence);

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