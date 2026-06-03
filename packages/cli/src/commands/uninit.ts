import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { CliContext, CliRunResult } from '../cli';
import { ok } from '../cli';
import { booleanValue, parseCommandArgs } from './parse';
import { resolveProjectPath } from '../root';
import { style } from '../format/style';

export async function runUninit(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    force: { type: 'boolean', short: 'f' },
    help: { type: 'boolean', short: 'h' },
  });
  const root = resolveProjectPath(ctx.cwd, parsed.positionals[0]);
  const dir = `${root}/.astrograph`;
  if (!existsSync(dir)) return ok(style.info(`No index at ${style.path(root)}`));
  if (!booleanValue(parsed.values, 'force') && !await confirmRemove(root)) {
    return ok(style.warn('Aborted'));
  }
  await rm(dir, { recursive: true, force: true });
  return ok(style.success(`Removed ${style.path(dir)}`));
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
