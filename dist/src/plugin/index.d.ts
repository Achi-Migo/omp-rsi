import { z } from 'zod';
import { EvolutionController, type EvolutionAction, type EvolutionBeginInput, type EvolutionRecordInput } from '../../.omp/tools/evolution.ts';
export interface ExtensionContext {
    cwd?: string;
    ui?: {
        notify(message: string, level?: 'info' | 'warning' | 'error'): void;
    };
}
export interface ExtensionAPI {
    cwd?: string;
    registerTool?: (tool: unknown) => void;
    registerCommand?: (name: string, command: {
        description: string;
        handler: (args: string, ctx: ExtensionContext) => unknown;
    }) => void;
    on?: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => void;
    zod?: typeof z;
}
export declare function getEvolutionController(cwd: string): EvolutionController;
export declare function createEvolutionBeginTool(api: ExtensionAPI): {
    name: string;
    label: string;
    description: string;
    parameters: z.ZodObject<{
        taskId: z.ZodOptional<z.ZodString>;
        objective: z.ZodString;
        skillName: z.ZodOptional<z.ZodString>;
        skillReused: z.ZodOptional<z.ZodBoolean>;
        stagingToolPath: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    approval: string;
    execute(_toolCallId: string, params: EvolutionBeginInput, _onUpdate?: unknown, ctx?: {
        cwd?: string;
    }): Promise<{
        content: {
            type: string;
            text: string;
        }[];
        details: EvolutionAction;
    }>;
    onSession(event: {
        reason?: string;
    }): void;
};
export declare function createEvolutionRecordTool(api: ExtensionAPI): {
    name: string;
    label: string;
    description: string;
    parameters: z.ZodObject<{
        runId: z.ZodString;
        candidateId: z.ZodString;
        diffPatch: z.ZodString;
        patchHash: z.ZodString;
        experience: z.ZodOptional<z.ZodString>;
        requestCount: z.ZodOptional<z.ZodNumber>;
        tokenCount: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    approval: string;
    execute(_toolCallId: string, params: EvolutionRecordInput, _onUpdate?: unknown, ctx?: {
        cwd?: string;
    }, signal?: AbortSignal): Promise<{
        content: {
            type: string;
            text: string;
        }[];
        details: EvolutionAction;
    }>;
};
export default function initializeRsiPlugin(api: ExtensionAPI): ({
    name: string;
    label: string;
    description: string;
    parameters: z.ZodObject<{
        taskId: z.ZodOptional<z.ZodString>;
        objective: z.ZodString;
        skillName: z.ZodOptional<z.ZodString>;
        skillReused: z.ZodOptional<z.ZodBoolean>;
        stagingToolPath: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    approval: string;
    execute(_toolCallId: string, params: EvolutionBeginInput, _onUpdate?: unknown, ctx?: {
        cwd?: string;
    }): Promise<{
        content: {
            type: string;
            text: string;
        }[];
        details: EvolutionAction;
    }>;
    onSession(event: {
        reason?: string;
    }): void;
} | {
    name: string;
    label: string;
    description: string;
    parameters: z.ZodObject<{
        runId: z.ZodString;
        candidateId: z.ZodString;
        diffPatch: z.ZodString;
        patchHash: z.ZodString;
        experience: z.ZodOptional<z.ZodString>;
        requestCount: z.ZodOptional<z.ZodNumber>;
        tokenCount: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    approval: string;
    execute(_toolCallId: string, params: EvolutionRecordInput, _onUpdate?: unknown, ctx?: {
        cwd?: string;
    }, signal?: AbortSignal): Promise<{
        content: {
            type: string;
            text: string;
        }[];
        details: EvolutionAction;
    }>;
})[];
