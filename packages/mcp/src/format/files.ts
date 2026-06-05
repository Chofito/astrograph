import type { FilesOutput, ToolResult } from "@astrograph/core";
import { empty, withBanner } from "./shared";

export function formatFiles(result: ToolResult<FilesOutput>): string {
	if (result.data.entries.length === 0)
		return withBanner(empty("Files"), result.meta);
	const lines = [`Files (${result.data.format})`];
	result.data.entries.forEach((entry) => {
		lines.push(
			`- ${entry.filePath} [${entry.language}] ${entry.nodeCount} symbols · ${entry.coverageState}`,
		);
	});
	return withBanner(lines.join("\n"), result.meta);
}
