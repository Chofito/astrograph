import type { SearchOutput, ToolResult } from "@astrograph/core";
import { empty, formatNode, withBanner } from "./shared";

export function formatSearch(result: ToolResult<SearchOutput>): string {
	if (result.data.length === 0) return withBanner(empty("Search"), result.meta);
	const lines = ["Search"];
	result.data.forEach((item, index) => {
		lines.push(
			`${index + 1}. ${formatNode(item.node)} · score ${item.score.toFixed(3)}`,
		);
	});
	return withBanner(lines.join("\n"), result.meta);
}
