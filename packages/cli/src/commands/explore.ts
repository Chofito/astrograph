import type { CliContext, CliRunResult } from '../cli';
import { CliError } from '../cli';
import { formatExplore } from '../format/explore';
import { numberValue, parseCommandArgs, readFlags, readOptions } from './parse';
import { openGraphForRead } from './shared';

export async function runExplore(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, readOptions({ 'max-files': { type: 'string' } }));
  if (parsed.positionals.length === 0) throw new CliError('Missing terms', 1);
  return openGraphForRead(
    ctx,
    readFlags(parsed.values),
    (graph) => graph.explore({ query: parsed.positionals.join(' '), maxFiles: numberValue(parsed.values, 'max-files') ?? 12 }),
    formatExplore,
  );
}
