import { runCallees } from "./commands/callees";
import { runCallers } from "./commands/callers";
import { runContext } from "./commands/context";
import { runDaemon } from "./commands/daemon";
import { runExplore } from "./commands/explore";
import { runFiles } from "./commands/files";
import { runImpact } from "./commands/impact";
import { runIndex } from "./commands/index";
import { runInit } from "./commands/init";
import { runInstall } from "./commands/install";
import { runNode } from "./commands/node";
import { runSearch } from "./commands/search";
import { runServe } from "./commands/serve";
import { runStatus } from "./commands/status";
import { runStop } from "./commands/stop";
import { runSync } from "./commands/sync";
import { runTrace } from "./commands/trace";
import { runUninit } from "./commands/uninit";
import { runUninstall } from "./commands/uninstall";
import { runUnlock } from "./commands/unlock";
import { commandHelp, globalHelp, versionText } from "./help";
import { type CliContext, CliError, type CliRunResult, ok } from "./result";

// The vocabulary lives in a leaf module (see result.ts); re-exported here so
// `import { CliError } from "../cli"` keeps working across the commands.
export {
	type CliContext,
	CliError,
	type CliRunResult,
	failOnPartial,
	ok,
} from "./result";

type CommandHandler = (
	args: string[],
	ctx: CliContext,
) => Promise<CliRunResult>;

const COMMANDS: Record<string, CommandHandler> = {
	init: runInit,
	uninit: runUninit,
	index: runIndex,
	sync: runSync,
	status: runStatus,
	unlock: runUnlock,
	stop: runStop,
	daemon: runDaemon,
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
	serve: runServe,
	install: runInstall,
	uninstall: runUninstall,
};

/** Dispatch one CLI invocation and translate all failures into a process result. */
export async function runCli(
	argv: string[],
	ctx: CliContext = { cwd: process.cwd() },
): Promise<CliRunResult> {
	try {
		if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
			return ok(globalHelp());
		}
		if (argv[0] === "--version" || argv[0] === "-V") {
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
		if (argv[1] === "--help" || argv[1] === "-h") {
			return ok(commandHelp(command));
		}
		return await handler(argv.slice(1), ctx);
	} catch (error) {
		if (error instanceof CliError) {
			return {
				exitCode: error.exitCode,
				stdout: "",
				stderr: `${error.message}\n`,
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		return { exitCode: 1, stdout: "", stderr: `${message}\n` };
	}
}
