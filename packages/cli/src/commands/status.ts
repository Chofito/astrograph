import type { CliContext, CliRunResult } from '../cli';
import { ok } from '../cli';
import { jsonEnvelope } from '../format/json';
import { formatStatus } from '../format/status';
import { requireProjectRoot, resolveProjectPath } from '../root';
import { booleanValue, parseCommandArgs } from './parse';
import { withGraph } from './shared';

export async function runStatus(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    json: { type: 'boolean', short: 'j' },
    help: { type: 'boolean', short: 'h' },
  });
  const root = requireProjectRoot(resolveProjectPath(ctx.cwd, parsed.positionals[0]));
  const result = await withGraph(root, (graph) => graph.getStats({}));
  return ok(booleanValue(parsed.values, 'json') ? jsonEnvelope(result) : formatStatus(result));
}
