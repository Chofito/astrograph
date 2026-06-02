import type { CliContext, CliRunResult } from '../cli';
import { formatTrace } from '../format/trace';
import { numberValue, parseCommandArgs, readFlags, readOptions, requirePositional } from './parse';
import { openGraphForRead } from './shared';

export async function runTrace(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, readOptions({ 'max-depth': { type: 'string', short: 'd' } }));
  const from = requirePositional(parsed.positionals, 0, 'from');
  const to = requirePositional(parsed.positionals, 1, 'to');
  return openGraphForRead(
    ctx,
    readFlags(parsed.values),
    (graph) => graph.trace({ from, to, maxDepth: numberValue(parsed.values, 'max-depth') }),
    formatTrace,
  );
}
