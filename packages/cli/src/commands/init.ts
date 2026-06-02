import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openProject } from '@astrograph/core/bun';
import type { CliContext, CliRunResult } from '../cli';
import { ok } from '../cli';
import { booleanValue, parseCommandArgs } from './parse';
import { loadConfig } from './shared';

export async function runInit(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    'no-index': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  });
  const root = resolve(ctx.cwd, parsed.positionals[0] ?? '.');
  await mkdir(`${root}/.astrograph`, { recursive: true });
  if (booleanValue(parsed.values, 'no-index')) {
    return ok(`initialized ${root}`);
  }

  const graph = await openProject(root, { config: await loadConfig(root) });
  try {
    await graph.indexAll();
  } finally {
    graph.close();
  }
  return ok(booleanValue(parsed.values, 'verbose') ? `initialized and indexed ${root}` : `indexed ${root}`);
}
