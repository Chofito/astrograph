import type { CliContext, CliRunResult } from '../cli';
import { ok } from '../cli';
import { requireProjectRoot, resolveProjectPath } from '../root';
import { booleanValue, parseCommandArgs } from './parse';
import { withGraph } from './shared';
import { style, symbols } from '../format/style';

export async function runIndex(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    force: { type: 'boolean', short: 'f' },
    quiet: { type: 'boolean', short: 'q' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  });
  const root = requireProjectRoot(resolveProjectPath(ctx.cwd, parsed.positionals[0]));
  
  const result = await withGraph(root, async (graph) => {
    await graph.indexAll({ force: booleanValue(parsed.values, 'force') });
    return graph.getStats({});
  });
  
  if (booleanValue(parsed.values, 'quiet')) return ok();
  
  const { fileCount, nodeCount, edgeCount, coverage } = result.data;
  const headerMsg = booleanValue(parsed.values, 'verbose') 
    ? `Indexed ${style.path(root)}` 
    : 'Indexed';
  
  const lines = [
    style.success(headerMsg),
    `  ${style.num(fileCount)} files ${symbols.bullet} ${style.num(nodeCount)} nodes ${symbols.bullet} ${style.num(edgeCount)} edges`,
    `  coverage ${style.num(coverage.resolved)}/${style.num(coverage.total)} resolved`,
  ];
  return ok(lines.join('\n'));
}
