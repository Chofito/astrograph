import type { CliContext, CliRunResult } from '../cli';
import { ok } from '../cli';
import { requireProjectRoot, resolveProjectPath } from '../root';
import { booleanValue, parseCommandArgs } from './parse';
import { withGraph } from './shared';

export async function runIndex(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    force: { type: 'boolean', short: 'f' },
    quiet: { type: 'boolean', short: 'q' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  });
  const root = requireProjectRoot(resolveProjectPath(ctx.cwd, parsed.positionals[0]));
  await withGraph(root, (graph) => graph.indexAll({ force: booleanValue(parsed.values, 'force') }));
  if (booleanValue(parsed.values, 'quiet')) return ok();
  return ok(booleanValue(parsed.values, 'verbose') ? `indexed ${root}` : 'indexed');
}
