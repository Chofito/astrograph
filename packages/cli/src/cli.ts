import { runCallers } from './commands/callers';
import { runCallees } from './commands/callees';
import { runContext } from './commands/context';
import { runExplore } from './commands/explore';
import { runFiles } from './commands/files';
import { runImpact } from './commands/impact';
import { runIndex } from './commands/index';
import { runInit } from './commands/init';
import { runNode } from './commands/node';
import { runSearch } from './commands/search';
import { runStatus } from './commands/status';
import { runSync } from './commands/sync';
import { runTrace } from './commands/trace';
import { runUninit } from './commands/uninit';
import { runUnlock } from './commands/unlock';
import { commandHelp, globalHelp, versionText } from './help';

export interface CliContext {
  cwd: string;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

type CommandHandler = (args: string[], ctx: CliContext) => Promise<CliRunResult>;

const COMMANDS: Record<string, CommandHandler> = {
  init: runInit,
  uninit: runUninit,
  index: runIndex,
  sync: runSync,
  status: runStatus,
  unlock: runUnlock,
  search: runSearch,
  query: runSearch,
  q: runSearch,
  context: runContext,
  trace: runTrace,
  callers: runCallers,
  callees: runCallees,
  impact: runImpact,
  node: runNode,
  explore: runExplore,
  files: runFiles,
};

export async function runCli(argv: string[], ctx: CliContext = { cwd: process.cwd() }): Promise<CliRunResult> {
  try {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      return ok(globalHelp());
    }
    if (argv[0] === '--version' || argv[0] === '-V') {
      return ok(versionText());
    }

    const command = argv[0];
    if (command === undefined) {
      return ok(globalHelp());
    }
    const handler = COMMANDS[command];
    if (handler === undefined) {
      throw new CliError(`Unknown command: ${command}\n\n${globalHelp()}`, 1);
    }
    if (argv[1] === '--help' || argv[1] === '-h') {
      return ok(commandHelp(command));
    }
    return await handler(argv.slice(1), ctx);
  } catch (error) {
    if (error instanceof CliError) {
      return { exitCode: error.exitCode, stdout: '', stderr: `${error.message}\n` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: '', stderr: `${message}\n` };
  }
}

export function ok(stdout = ''): CliRunResult {
  return { exitCode: 0, stdout: stdout === '' || stdout.endsWith('\n') ? stdout : `${stdout}\n`, stderr: '' };
}

export function failOnPartial(stdout: string, partial: boolean): CliRunResult {
  return { exitCode: partial ? 3 : 0, stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, stderr: '' };
}
