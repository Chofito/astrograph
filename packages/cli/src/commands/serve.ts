import { serveMcp } from '@astrograph/mcp';
import { CliError, ok, type CliContext, type CliRunResult } from '../cli';
import { booleanValue, parseCommandArgs, stringValue } from './parse';

export async function runServe(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    mcp: { type: 'boolean' },
    path: { type: 'string', short: 'p' },
    help: { type: 'boolean', short: 'h' },
  });
  if (!booleanValue(parsed.values, 'mcp')) {
    throw new CliError('Only MCP serving is supported here. Use `astrograph serve --mcp [--path <dir>]`.', 1);
  }
  await serveMcp({ cwd: ctx.cwd, path: stringValue(parsed.values, 'path') });
  return ok();
}
