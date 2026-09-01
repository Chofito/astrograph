import { style } from "../format/style";
import type { CliContext, CliRunResult } from "../result";
import { ok } from "../result";
import { resolveProjectPath } from "../root";
import {
	isDaemonRunning,
	readDaemonMetadata,
	stopDaemon,
} from "./daemon-utils";
import { parseCommandArgs } from "./parse";

export async function runStop(
	args: string[],
	ctx: CliContext,
): Promise<CliRunResult> {
	const parsed = parseCommandArgs(args, {
		help: { type: "boolean", short: "h" },
	});

	const root = resolveProjectPath(ctx.cwd, parsed.positionals[0]);

	if (!isDaemonRunning(root)) {
		return ok(style.info("No daemon running"));
	}

	const metadata = readDaemonMetadata(root);
	if (await stopDaemon(root)) {
		return ok(
			style.success(`Daemon stopped (pid ${metadata?.pid ?? "unknown"})`),
		);
	}

	return ok(style.info("No daemon running"));
}
