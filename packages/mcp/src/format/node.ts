import type { NodeOutput, ToolResult } from "@astrograph/core";
import { formatCodeBlock, formatNode, withBanner } from "./shared";

export function formatNodeDetails(result: ToolResult<NodeOutput>): string {
	const lines = ["Node", formatNode(result.data.node)];
	if (result.data.docstring !== undefined && result.data.docstring !== "") {
		lines.push("", result.data.docstring);
	}
	if (result.data.callersPreview.length > 0) {
		lines.push("", "Callers preview");
		result.data.callersPreview.forEach((node) =>
			lines.push(`- ${formatNode(node)}`),
		);
	}
	if (result.data.calleesPreview.length > 0) {
		lines.push("", "Callees preview");
		result.data.calleesPreview.forEach((node) =>
			lines.push(`- ${formatNode(node)}`),
		);
	}
	if (result.data.code !== undefined) {
		lines.push("", formatCodeBlock(result.data.code));
	}
	return withBanner(lines.join("\n"), result.meta);
}
