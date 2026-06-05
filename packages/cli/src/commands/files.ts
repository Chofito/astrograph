import type { FilesInput } from "@astrograph/core";
import type { CliContext, CliRunResult } from "../cli";
import { CliError } from "../cli";
import { formatFiles } from "../format/files";
import {
	booleanValue,
	numberValue,
	parseCommandArgs,
	readFlags,
	readOptions,
	stringValue,
} from "./parse";
import { openGraphForRead } from "./shared";

export async function runFiles(
	args: string[],
	ctx: CliContext,
): Promise<CliRunResult> {
	const parsed = parseCommandArgs(
		args,
		readOptions({
			filter: { type: "string" },
			pattern: { type: "string" },
			format: { type: "string" },
			"max-depth": { type: "string" },
			"no-metadata": { type: "boolean" },
		}),
	);
	const format = (stringValue(parsed.values, "format") ??
		"tree") as FilesInput["format"];
	if (format !== "tree" && format !== "flat" && format !== "grouped") {
		throw new CliError("Expected --format to be tree, flat, or grouped", 1);
	}
	const includeMetadata = !booleanValue(parsed.values, "no-metadata");
	return openGraphForRead(
		ctx,
		readFlags(parsed.values),
		(graph) =>
			graph.getFiles({
				path: stringValue(parsed.values, "filter"),
				pattern: stringValue(parsed.values, "pattern"),
				format,
				includeMetadata,
				maxDepth: numberValue(parsed.values, "max-depth"),
			}),
		(result) => formatFiles(result, includeMetadata),
	);
}
