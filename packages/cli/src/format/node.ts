import type { NodeOutput, NodeRef, ToolResult } from "@astrograph/core";
import { footer } from "./footer";
import { loc } from "./shared";

export function formatNode(result: ToolResult<NodeOutput>): string {
	const lines = [
		`${result.data.node.kind} ${result.data.node.name}`,
		`location ${loc(result.data.node)}`,
	];
	if (result.data.node.signature !== undefined)
		lines.push(`signature ${result.data.node.signature}`);
	if (result.data.callersPreview.length > 0)
		lines.push(`callers ${names(result.data.callersPreview)}`);
	if (result.data.calleesPreview.length > 0)
		lines.push(`callees ${names(result.data.calleesPreview)}`);
	if (result.data.code !== undefined) {
		lines.push("```");
		lines.push(result.data.code.content);
		lines.push("```");
	}
	lines.push(footer(result.meta));
	return lines.join("\n");
}

function names(nodes: NodeRef[]): string {
	return nodes.map((node) => node.name).join(", ");
}
