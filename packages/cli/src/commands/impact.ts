import type { CliContext, CliRunResult } from "../cli";
import { formatImpact } from "../format/impact";
import {
	booleanValue,
	numberValue,
	parseCommandArgs,
	readFlags,
	readOptions,
	requirePositional,
} from "./parse";
import { openGraphForRead } from "./shared";

export async function runImpact(
	args: string[],
	ctx: CliContext,
): Promise<CliRunResult> {
	const parsed = parseCommandArgs(
		args,
		readOptions({
			depth: { type: "string", short: "d" },
			"include-external": { type: "boolean" },
		}),
	);
	const symbol = requirePositional(parsed.positionals, 0, "symbol");
	return openGraphForRead(
		ctx,
		readFlags(parsed.values),
		(graph) =>
			graph.impact({
				symbol,
				depth: numberValue(parsed.values, "depth") ?? 2,
				includeExternal: booleanValue(parsed.values, "include-external")
					? true
					: undefined,
			}),
		formatImpact,
	);
}
