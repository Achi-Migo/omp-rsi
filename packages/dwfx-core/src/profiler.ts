import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
export class ContextProfiler {
  public profile(cwd = process.cwd()): ContextProfile {
    const has = (file: string) => existsSync(join(cwd, file));
    const hasPackage = has('package.json');
    const hasTypescript = has('tsconfig.json');
    const hasGo = has('go.mod');
    const hasRust = has('Cargo.toml');
    const hasPython = has('pyproject.toml') || has('requirements.txt');
    const hasMake = has('Makefile');
    const packageManager: PackageManager = has('pnpm-lock.yaml')
      ? 'pnpm'
      : has('yarn.lock')
        ? 'yarn'
        : has('bun.lock') || has('bun.lockb')
          ? 'bun'
          : hasPackage
            ? 'npm'
            : 'none';

    const language = hasTypescript
      ? 'typescript'
      : hasPackage
        ? 'javascript'
        : hasGo
          ? 'go'
          : hasRust
            ? 'rust'
            : hasPython
              ? 'python'
              : hasMake
                ? 'make'
                : 'unknown';
    const buildCmd = hasPackage
      ? `${packageManager} run build`
      : hasGo
        ? 'go build ./...'
        : hasRust
          ? 'cargo build'
          : hasPython
            ? 'python -m build'
            : hasMake
              ? 'make'
              : undefined;
    const testCmd = hasPackage
      ? `${packageManager} test`
      : hasGo
        ? 'go test ./...'
        : hasRust
          ? 'cargo test'
          : hasPython
            ? 'python -m pytest'
            : hasMake
              ? 'make test'
              : undefined;
    const typecheckCmd = hasTypescript
      ? hasPackage
        ? `${packageManager} run typecheck`
        : 'tsc --noEmit'
      : undefined;
    const capabilities = [
      ...(buildCmd ? ['build'] : []),
      ...(testCmd ? ['test'] : []),
      ...(typecheckCmd ? ['typecheck'] : []),
      ...(has('AGENTS.md') ? ['agent-instructions'] : []),
      ...(has('.git') ? ['git'] : []),
    ];

    return { language, packageManager, buildCmd, testCmd, typecheckCmd, hasTypescript, capabilities };
  }
}
