/**
 * Five-table journal DDL, transcribed from assets/journal-schema.sql (ZCode dwf_* tables).
 * 拍板表#16：约束对齐 DDL 原文，不放松——dwf_run 三约束 / dwf_event payload_json not null /
 * session_task_link 的 NOT NULL 列与 unique(child_session_id) / dwf_run_cwd_idx 与
 * dwf_event_artifact_idx 两索引全部补回；`if not exists` 幂等化保留（语义等价）；
 * 指向五表外实体（workflow_run / workflow_activity / session）的外键以注释保留——
 * MVP 空表不接线，接入真实宿主时按原文恢复。
 */
import type { DatabaseSync } from 'node:sqlite';
export declare function initSchema(db: DatabaseSync): void;
