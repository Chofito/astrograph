import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { CliContext, CliRunResult } from '../cli';
import { ok } from '../cli';
import { requireProjectRoot, resolveProjectPath } from '../root';
import { parseCommandArgs } from './parse';

export async function runUnlock(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, { help: { type: 'boolean', short: 'h' } });
  const root = requireProjectRoot(resolveProjectPath(ctx.cwd, parsed.positionals[0]));
  const lockPaths = [`${root}/.astrograph/lock`, `${root}/.astrograph/index.lock`];
  let removed = 0;
  for (const path of lockPaths) {
    if (existsSync(path)) {
      await rm(path, { force: true });
      removed += 1;
    }
  }
  return ok(`removed ${removed} lock file(s)`);
}
