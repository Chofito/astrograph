import type { CliContext, CliRunResult } from '../cli';
import { ok } from '../cli';
import { requireProjectRoot, resolveProjectPath } from '../root';
import { booleanValue, parseCommandArgs } from './parse';
import { withGraph } from './shared';

export async function runSync(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    quiet: { type: 'boolean', short: 'q' },
    help: { type: 'boolean', short: 'h' },
  });
  const root = requireProjectRoot(resolveProjectPath(ctx.cwd, parsed.positionals[0]));
  const result = await withGraph(root, (graph) => graph.sync());
  if (booleanValue(parsed.values, 'quiet')) return ok();
  return ok(`sync added:${result.added.length} modified:${result.modified.length} removed:${result.removed.length}`);
}
