export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'none';
export interface ContextProfile {
    language: 'typescript' | 'javascript' | 'go' | 'rust' | 'python' | 'make' | 'unknown';
    packageManager: PackageManager;
    buildCmd?: string;
    testCmd?: string;
    typecheckCmd?: string;
    hasTypescript: boolean;
    capabilities: string[];
}
/** Detects project capabilities from manifest existence only; no file contents are read. */
export declare class ContextProfiler {
    profile(cwd?: string): ContextProfile;
}
