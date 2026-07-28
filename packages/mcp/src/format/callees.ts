import type { CalleesOutput, ToolResult } from "@astrograph/core";
import { emptyWithNotes, formatEdge, formatNode, withBanner } from "./shared";

export function formatCallees(result: ToolResult<CalleesOutput>): string {
	if (result.data.length === 0)
		return withBanner(emptyWithNotes("Callees", result.meta), result.meta);
	const lines = ["Callees"];
	result.data.forEach((item, index) => {
		lines.push(`${index + 1}. ${formatNode(item.callee)}`);
		lines.push(`   via ${formatEdge(item.callSite)}`);
	});
	return withBanner(lines.join("\n"), result.meta);
}
