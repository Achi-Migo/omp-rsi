import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { CustomToolAPI } from '@oh-my-pi/pi-coding-agent';
import type { HookAPI } from '@oh-my-pi/pi-coding-agent/extensibility/hooks';
import {
  EvolutionController,
  toolText,
  type EvolutionAction,
  type EvolutionBeginInput,
  type EvolutionRecordInput,
} from '../../.omp/tools/evolution.ts';
import { ContextProfiler } from '../../packages/dwfx-core/src/profiler.ts';
import contextProfilerHook, { formatContextProfile } from '../../.omp/hooks/pre/context-profiler.ts';
import { createEvolutionLearnerHook } from '../../.omp/hooks/pre/evolution-learner.ts';
import { RsiStore } from '../journal/rsi-store.ts';

export interface ExtensionContext {
  cwd?: string;
  ui?: {
    notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  };
}

export interface ExtensionAPI {
  cwd?: string;
  registerTool?: (tool: unknown) => void;
  registerCommand?: (
    name: string,
    command: { description: string; handler: (args: string, ctx: ExtensionContext) => unknown },
  ) => void;
  on?: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => void;
  zod?: typeof z;
}

const controllers = new Map<string, EvolutionController>();

export function getEvolutionController(cwd: string): EvolutionController {
  const resolved = path.resolve(cwd || process.cwd());
  let controller = controllers.get(resolved);
  if (!controller) {
    controller = new EvolutionController({ cwd: resolved });
    controllers.set(resolved, controller);
  }
  return controller;
}

export function createEvolutionBeginTool(api: ExtensionAPI) {
  const zod = api.zod ?? z;
  return {
    name: 'evolution_begin',
    label: 'Begin Evolution Run',
    description: 'Initialize two bounded draft candidates and return the first smol-agent task prompt.',
    parameters: zod.object({
      taskId: zod.string().optional(),
      objective: zod.string(),
      skillName: zod.string().optional(),
      skillReused: zod.boolean().optional(),
      stagingToolPath: zod.string().optional(),
    }),
    approval: 'exec',
    async execute(_toolCallId: string, params: EvolutionBeginInput, _onUpdate?: unknown, ctx?: { cwd?: string }) {
      const activeCwd = ctx?.cwd ?? api.cwd ?? process.cwd();
      const controller = getEvolutionController(activeCwd);
      const action = await controller.begin(params);
      return { content: [{ type: 'text', text: toolText(action) }], details: action };
    },
    onSession(event: { reason?: string }) {
      if (event.reason === 'shutdown') {
        for (const c of controllers.values()) c.close();
        controllers.clear();
      }
    },
  };
}

export function createEvolutionRecordTool(api: ExtensionAPI) {
  const zod = api.zod ?? z;
  return {
    name: 'evolution_record',
    label: 'Evaluate Evolution Candidate',
    description: 'Verify a patch hash, evaluate serially in an isolated sandbox, and advance or arbitrate the run.',
    parameters: zod.object({
      runId: zod.string(),
      candidateId: zod.string(),
      diffPatch: zod.string(),
      patchHash: zod.string(),
      experience: zod.string().optional(),
      requestCount: zod.number().optional(),
      tokenCount: zod.number().optional(),
    }),
    approval: 'exec',
    async execute(
      _toolCallId: string,
      params: EvolutionRecordInput,
      _onUpdate?: unknown,
      ctx?: { cwd?: string },
      signal?: AbortSignal,
    ) {
      const activeCwd = ctx?.cwd ?? api.cwd ?? process.cwd();
      const controller = getEvolutionController(activeCwd);
      const action = await controller.record(params, signal);
      return { content: [{ type: 'text', text: toolText(action) }], details: action };
    },
  };
}

export default function initializeRsiPlugin(api: ExtensionAPI) {
  const workspaceRoot = path.resolve(api.cwd ?? process.cwd());

  // Project-level override: if the workspace root already contains its own
  // .omp/tools/evolution.ts (e.g. during core development inside omp-rsi repo),
  // local project tools take precedence, avoiding duplicate tool registrations.
  const hasLocalEvolutionTool = fs.existsSync(path.join(workspaceRoot, '.omp', 'tools', 'evolution.ts'));
  const hasLocalProfilerHook = fs.existsSync(path.join(workspaceRoot, '.omp', 'hooks', 'pre', 'context-profiler.ts'));
  const hasLocalLearnerHook = fs.existsSync(path.join(workspaceRoot, '.omp', 'hooks', 'pre', 'evolution-learner.ts'));

  const beginTool = createEvolutionBeginTool(api);
  const recordTool = createEvolutionRecordTool(api);

  if (!hasLocalEvolutionTool && typeof api.registerTool === 'function') {
    api.registerTool(beginTool);
    api.registerTool(recordTool);
  }

  if (typeof api.on === 'function') {
    if (!hasLocalProfilerHook) {
      contextProfilerHook(api as unknown as HookAPI);
    }
    if (!hasLocalLearnerHook) {
      const learnerHook = createEvolutionLearnerHook();
      learnerHook(api as unknown as HookAPI);
    }
  }

  if (typeof api.registerCommand === 'function') {
    api.registerCommand('rsi-status', {
      description: 'Inspect active RSI state and Pareto frontier',
      handler: async (_args: string, ctx: ExtensionContext) => {
        const activeCwd = path.resolve(ctx?.cwd ?? api.cwd ?? process.cwd());
        const dbPath = path.join(activeCwd, '.omp', 'rsi.db');
        if (!fs.existsSync(dbPath)) {
          const msg = `No RSI ledger found in workspace (${dbPath})`;
          ctx?.ui?.notify?.(msg, 'info');
          return { found: false, cwd: activeCwd };
        }
        try {
          const store = RsiStore.open(dbPath);
          const metrics = store.metrics();
          store.close();
          const msg = `RSI Ledger: ${metrics.taskCount} tasks, ${metrics.candidateCount} candidates (${metrics.passedCandidateCount} passed).`;
          ctx?.ui?.notify?.(msg, 'info');
          return { found: true, metrics };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const msg = `RSI Ledger read failed: ${errMsg}`;
          ctx?.ui?.notify?.(msg, 'error');
          return { found: true, error: errMsg };
        }
      },
    });
  }

  // Also return tools array for compatibility if invoked as tool factory
  return [beginTool, recordTool];
}
