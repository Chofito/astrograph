import type { ContextOutput, ToolResult } from "@astrograph/core";
import {
	empty,
	formatCodeBlock,
	formatEdge,
	formatNode,
	withBanner,
} from "./shared";

export function formatContext(result: ToolResult<ContextOutput>): string {
	const data = result.data;
	if (data.entryPoints.length === 0 && data.subgraph.nodes.length === 0) {
		return withBanner(empty("Context"), result.meta);
	}

	const lines = ["Context"];
	if (data.entryPoints.length > 0) {
		lines.push("", "Entry points");
		data.entryPoints.forEach((node, index) =>
			lines.push(`${index + 1}. ${formatNode(node)}`),
		);
	}
	if (data.subgraph.nodes.length > 0) {
		lines.push("", "Symbols");
		data.subgraph.nodes.forEach((node, index) => {
			const reason = data.inclusionReasons[node.id] ?? "included";
			lines.push(`${index + 1}. ${formatNode(node)} · ${reason}`);
		});
	}
	if (data.subgraph.edges.length > 0) {
		lines.push("", "Edges");
		data.subgraph.edges.forEach((edge) => lines.push(`- ${formatEdge(edge)}`));
	}
	if (data.codeBlocks.length > 0) {
		lines.push("", "Code");
		data.codeBlocks.forEach((block) => lines.push(formatCodeBlock(block)));
	}
	if (data.relatedFiles.length > 0) {
		lines.push("", `Related files: ${data.relatedFiles.join(", ")}`);
	}
	lines.push(
		"",
		`Stats: ${data.stats.nodeCount} nodes, ${data.stats.edgeCount} edges, ${data.stats.fileCount} files, ${data.stats.codeBlockCount} code blocks, ${data.stats.totalCodeChars} chars`,
	);
	return withBanner(lines.join("\n"), result.meta);
}
