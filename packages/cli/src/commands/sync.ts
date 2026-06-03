import type { CliContext, CliRunResult } from '../cli';
import { ok } from '../cli';
import { requireProjectRoot, resolveProjectPath } from '../root';
import { booleanValue, parseCommandArgs } from './parse';
import { withGraph } from './shared';
import { style, symbols } from '../format/style';

export async function runSync(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    quiet: { type: 'boolean', short: 'q' },
    help: { type: 'boolean', short: 'h' },
  });
  const root = requireProjectRoot(resolveProjectPath(ctx.cwd, parsed.positionals[0]));
  const result = await withGraph(root, (graph) => graph.sync());
  if (booleanValue(parsed.values, 'quiet')) return ok();
  
  const { added, modified, removed } = result;
  if (added.length === 0 && modified.length === 0 && removed.length === 0) {
    return ok(style.info('Nothing to update'));
  }
  
  const parts = [
    style.added(added.length),
    style.modified(modified.length),
    style.removed(removed.length),
  ];
  return ok(`${style.success('Synced')}  ${parts.join(` ${symbols.bullet} `)}`);
}
