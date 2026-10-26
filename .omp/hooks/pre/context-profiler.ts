import type { HookAPI } from '@oh-my-pi/pi-coding-agent/extensibility/hooks';
import { ContextProfiler } from '../../../packages/dwfx-core/src/profiler.ts';
import type { ContextProfile } from '../../../packages/dwfx-core/src/profiler.ts';

export function formatContextProfile(profile: ContextProfile): string {
  return [
    'Automatically detected engineering context (manifest existence only):',
    `language=${profile.language}; packageManager=${profile.packageManager}; typescript=${profile.hasTypescript}`,
    `buildCmd=${profile.buildCmd ?? 'unknown'}; testCmd=${profile.testCmd ?? 'unknown'}; typecheckCmd=${profile.typecheckCmd ?? 'unknown'}`,
    `capabilities=${profile.capabilities.join(',') || 'none'}`,
  ].join('\n');
}

export default function contextProfilerHook(pi: HookAPI): void {
  const profiler = new ContextProfiler();
  pi.on('before_agent_start', (_event, ctx) => {
    const profile = profiler.profile(ctx.cwd);
    return {
      message: {
        customType: 'context-profile',
        content: formatContextProfile(profile),
        display: false,
        details: profile,
      },
    };
  });
  pi.registerCommand('profiler', {
    description: 'Show the automatically detected project build and test profile',
    handler: (_args, ctx) => {
      const profile = profiler.profile(ctx.cwd);
      ctx.ui.notify(formatContextProfile(profile), 'info');
      return profile;
    },
  });
}
