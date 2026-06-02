import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CliError } from './cli';

export function findProjectRoot(startPath: string): string | undefined {
  let current = normalizeStart(startPath);
  while (true) {
    if (existsSync(`${current}/.astrograph`)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function requireProjectRoot(startPath: string): string {
  const root = findProjectRoot(startPath);
  if (root === undefined) {
    throw new CliError('No Astrograph index found. Run `astrograph init` first.', 2);
  }
  return root;
}

export function resolveProjectPath(cwd: string, path: string | undefined): string {
  return resolve(cwd, path ?? '.');
}

function normalizeStart(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return resolved;
  return statSync(resolved).isDirectory() ? resolved : dirname(resolved);
}
