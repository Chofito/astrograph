import { formatExplore } from "../format/explore";
import type { CliContext, CliRunResult } from "../result";
import { CliError } from "../result";
import { numberValue, parseCommandArgs, readFlags, readOptions } from "./parse";
import { openGraphForRead } from "./shared";

export async function runExplore(
	args: string[],
	ctx: CliContext,
): Promise<CliRunResult> {
	const parsed = parseCommandArgs(
		args,
		readOptions({ "max-files": { type: "string" } }),
	);
	if (parsed.positionals.length === 0) throw new CliError("Missing terms", 1);
	return openGraphForRead(
		ctx,
		readFlags(parsed.values),
		(graph) =>
			graph.explore({
				query: parsed.positionals.join(" "),
				maxFiles: numberValue(parsed.values, "max-files") ?? 12,
			}),
		formatExplore,
	);
}
