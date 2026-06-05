import type { CliContext, CliRunResult } from "../cli";
import { formatCallees } from "../format/callees";
import {
	booleanValue,
	numberValue,
	parseCommandArgs,
	readFlags,
	readOptions,
	requirePositional,
} from "./parse";
import { openGraphForRead } from "./shared";

export async function runCallees(
	args: string[],
	ctx: CliContext,
): Promise<CliRunResult> {
	const parsed = parseCommandArgs(
		args,
		readOptions({
			limit: { type: "string", short: "l" },
			"include-external": { type: "boolean" },
		}),
	);
	const symbol = requirePositional(parsed.positionals, 0, "symbol");
	return openGraphForRead(
		ctx,
		readFlags(parsed.values),
		(graph) =>
			graph.callees({
				symbol,
				limit: numberValue(parsed.values, "limit") ?? 20,
				includeExternal: booleanValue(parsed.values, "include-external")
					? true
					: undefined,
			}),
		formatCallees,
	);
}
