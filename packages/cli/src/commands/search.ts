import type { Language, NodeKind } from '@astrograph/core';
import type { CliContext, CliRunResult } from '../cli';
import { formatSearch } from '../format/search';
import { booleanValue, numberValue, parseCommandArgs, readFlags, readOptions, requirePositional, stringValue } from './parse';
import { openGraphForRead } from './shared';

export async function runSearch(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, readOptions({
    limit: { type: 'string', short: 'l' },
    kind: { type: 'string', short: 'k' },
    lang: { type: 'string' },
    'no-generated': { type: 'boolean' },
  }));
  const query = requirePositional(parsed.positionals, 0, 'query');
  return openGraphForRead(
    ctx,
    readFlags(parsed.values),
    (graph) => graph.search({
      query,
      limit: numberValue(parsed.values, 'limit') ?? 10,
      kind: stringValue(parsed.values, 'kind') as NodeKind | undefined,
      lang: stringValue(parsed.values, 'lang') as Language | undefined,
      includeGenerated: booleanValue(parsed.values, 'no-generated') ? false : undefined,
    }),
    formatSearch,
  );
}
