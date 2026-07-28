import type { CallersOutput, ToolResult } from "@astrograph/core";
import { emptyWithNotes, formatEdge, formatNode, withBanner } from "./shared";

export function formatCallers(result: ToolResult<CallersOutput>): string {
	if (result.data.length === 0)
		return withBanner(emptyWithNotes("Callers", result.meta), result.meta);
	const lines = ["Callers"];
	result.data.forEach((item, index) => {
		lines.push(`${index + 1}. ${formatNode(item.caller)}`);
		lines.push(`   via ${formatEdge(item.callSite)}`);
	});
	return withBanner(lines.join("\n"), result.meta);
}
