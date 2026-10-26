/** Minimal project-local typings for APIs supplied by the installed omp host. */

declare module "@oh-my-pi/pi-coding-agent/extensibility/hooks" {
  export interface HookUIContext {
    notify(message: string, level?: "info" | "warning" | "error"): void;
  }

  export interface HookContext {
    readonly cwd: string;
    readonly hasUI: boolean;
    readonly ui: HookUIContext;
  }

  export interface HookEventMap {
    tool_call: {
      toolName: string;
      toolCallId?: string;
      input: Record<string, unknown>;
    };
    tool_result: {
      toolName: string;
      toolCallId?: string;
      isError?: boolean;
    };
    session_before_switch: Record<string, never>;
    session_before_compact: Record<string, never>;
    turn_end: Record<string, never>;
    before_agent_start: { prompt: string };
    agent_end: { isTerminal?: boolean };
  }

  export interface HookAPI {
    on<K extends keyof HookEventMap>(
      event: K,
      handler: (event: HookEventMap[K], ctx: HookContext) => unknown,
    ): void;
    registerCommand(
      name: string,
      command: {
        description: string;
        handler: (args: string, ctx: HookContext) => unknown;
      },
    ): void;
  }
}

declare module "@oh-my-pi/pi-coding-agent" {
  export interface OmpSchema {
    optional(): OmpSchema;
  }

  export interface CustomToolAPI {
    readonly cwd: string;
    readonly zod: {
      object(shape: Record<string, OmpSchema>): OmpSchema;
      string(): OmpSchema;
      boolean(): OmpSchema;
      number(): OmpSchema;
    };
  }
}
