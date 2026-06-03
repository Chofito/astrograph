import { CliError, ok, type CliContext, type CliRunResult } from '../cli';
import { booleanValue, numberValue, parseCommandArgs, stringValue } from './parse';

export async function runWeb(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    path: { type: 'string', short: 'p' },
    port: { type: 'string' },
    open: { type: 'boolean', short: 'o' },
    help: { type: 'boolean', short: 'h' },
  });

  if (booleanValue(parsed.values, 'help')) {
    return ok([
      'Usage: astrograph web [options]',
      '',
      'Options:',
      '  -p, --path <dir>     Project path (defaults to cwd)',
      '      --port <n>       Server port (default: 3000)',
      '  -o, --open           Open browser automatically',
      '  -h, --help           Show help',
    ].join('\n'));
  }

  const port = numberValue(parsed.values, 'port');
  const path = stringValue(parsed.values, 'path');
  const open = booleanValue(parsed.values, 'open');

  const { serveWeb } = await import('@astrograph/web');
  await serveWeb({ cwd: ctx.cwd, path, port, open });
  return ok();
}
