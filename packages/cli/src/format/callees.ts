import type { CalleesOutput, ToolResult } from "@astrograph/core";
import { footer } from "./footer";
import { loc } from "./shared";

export function formatCallees(result: ToolResult<CalleesOutput>): string {
	const rows = result.data.map(
		(item) =>
			`${item.callee.kind} ${item.callee.name}  ${loc(item.callee)}  ${edgeLoc(item.callSite)}`,
	);
	return [...rows, footer(result.meta)].join("\n");
}

function edgeLoc(edge: CalleesOutput[number]["callSite"]): string {
	return `at ${edge.line ?? "?"}:${edge.col ?? "?"}`;
}
