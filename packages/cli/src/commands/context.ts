import type { CliContext, CliRunResult } from '../cli';
import { CliError } from '../cli';
import { formatContext } from '../format/context';
import { jsonEnvelope } from '../format/json';
import { booleanValue, numberValue, parseCommandArgs, readFlags, readOptions, requirePositional, stringValue } from './parse';
import { openGraphForRead } from './shared';

export async function runContext(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, readOptions({
    'max-symbols': { type: 'string', short: 'n' },
    'no-code': { type: 'boolean' },
    budget: { type: 'string' },
    format: { type: 'string', short: 'f' },
  }));
  requirePositional(parsed.positionals, 0, 'task');
  const task = parsed.positionals.join(' ');
  const format = stringValue(parsed.values, 'format');
  if (format !== undefined && format !== 'markdown' && format !== 'json') {
    throw new CliError('Expected --format to be markdown or json', 1);
  }
  return openGraphForRead(
    ctx,
    { ...readFlags(parsed.values), json: readFlags(parsed.values).json === true || format === 'json' },
    (graph) => graph.context({
      task,
      maxSymbols: numberValue(parsed.values, 'max-symbols') ?? 20,
      includeCode: booleanValue(parsed.values, 'no-code') ? false : undefined,
      tokenBudget: numberValue(parsed.values, 'budget'),
    }),
    (result) => format === 'json' ? jsonEnvelope(result) : formatContext(result),
  );
}
