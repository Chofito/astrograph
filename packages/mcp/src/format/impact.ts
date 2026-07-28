import type { ImpactOutput, ToolResult } from "@astrograph/core";
import { emptyWithNotes, formatEdge, formatNode, withBanner } from "./shared";

export function formatImpact(result: ToolResult<ImpactOutput>): string {
	if (result.data.length === 0)
		return withBanner(emptyWithNotes("Impact", result.meta), result.meta);
	const lines = ["Impact"];
	result.data.forEach((item, index) => {
		lines.push(`${index + 1}. d=${item.distance} ${formatNode(item.node)}`);
		if (item.viaPath.length > 0)
			lines.push(`   via ${item.viaPath.map(formatEdge).join(" -> ")}`);
	});
	return withBanner(lines.join("\n"), result.meta);
}
