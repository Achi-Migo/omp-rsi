import type { HookAPI } from '@oh-my-pi/pi-coding-agent/extensibility/hooks';
import type { ContextProfile } from '../../../packages/dwfx-core/src/profiler.ts';
export declare function formatContextProfile(profile: ContextProfile): string;
export default function contextProfilerHook(pi: HookAPI): void;
