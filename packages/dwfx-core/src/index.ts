/**
 * @zakza/dwfx-core
 * Zero-dependency, invariant-enforced workflow mechanisms extracted from dsh-dwf
 */

// INV-1: Ledger
export {
  Ledger,
  type AgentOutcome,
  type AgentInfo,
  type LedgerEvent,
  type LedgerOptions,
} from './ledger.ts';

// INV-2: KeyedScheduler
export {
  KeyedScheduler,
  type SchedulableTask,
  type KeyedSchedulerOptions,
} from './scheduler.ts';

// INV-3: Journal & Stream Projection
export {
  MemoryJournalWriter,
  projectStream,
  DEFAULT_MAX_NODES,
  type StreamEvent,
  type ProjectedNodeView,
  type ProjectedRunView,
} from './projection.ts';

// INV-4: Lossless JSON & Fingerprinting
export {
  snapshotJsonValue,
  fnv1a32,
  MaterializeError,
  type JsonPrimitive,
  type JsonValue,
  type JsonObject,
  type JsonArray,
} from './json.ts';

// OpenRSI: automatic engineering context profile
export {
  ContextProfiler,
  type ContextProfile,
  type PackageManager,
} from './profiler.ts';

// OpenRSI: Evolution Engine & Invariant-backed Operators
export {
  EvolutionEngine,
  ParetoArbiter,
  inspectPatch,
  type OperatorKind,
  type CandidateStatus,
  type CandidateMetrics,
  type CandidateSolution,
  type CandidateRegistration,
  type EvaluationOutcome,
  type EvaluationResult,
  type PatchSummary,
  type ParetoResult,
  type EvolutionCycleOptions,
} from './evolution.ts';
