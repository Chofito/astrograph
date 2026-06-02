import type { CliContext, CliRunResult } from '../cli';
import { formatNode } from '../format/node';
import { booleanValue, parseCommandArgs, readFlags, readOptions, requirePositional } from './parse';
import { openGraphForRead } from './shared';

export async function runNode(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, readOptions({ code: { type: 'boolean', short: 'c' } }));
  const symbol = requirePositional(parsed.positionals, 0, 'symbol');
  return openGraphForRead(
    ctx,
    readFlags(parsed.values),
    (graph) => graph.getNode({ symbol, includeCode: booleanValue(parsed.values, 'code') }),
    formatNode,
  );
}
