import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { CliContext, CliRunResult } from '../cli';
import { ok } from '../cli';
import { booleanValue, parseCommandArgs } from './parse';
import { resolveProjectPath } from '../root';

export async function runUninit(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    force: { type: 'boolean', short: 'f' },
    help: { type: 'boolean', short: 'h' },
  });
  const root = resolveProjectPath(ctx.cwd, parsed.positionals[0]);
  const dir = `${root}/.astrograph`;
  if (!existsSync(dir)) return ok(`no index at ${root}`);
  if (!booleanValue(parsed.values, 'force') && !await confirmRemove(root)) {
    return ok('aborted');
  }
  await rm(dir, { recursive: true, force: true });
  return ok(`removed ${dir}`);
}

async function confirmRemove(root: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Remove ${root}/.astrograph? [y/N] `);
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}
