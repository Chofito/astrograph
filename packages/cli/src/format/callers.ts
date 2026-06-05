import type { CallersOutput, ToolResult } from "@astrograph/core";
import { footer } from "./footer";
import { loc } from "./shared";

export function formatCallers(result: ToolResult<CallersOutput>): string {
	const rows = result.data.map(
		(item) =>
			`${item.caller.kind} ${item.caller.name}  ${loc(item.caller)}  ${edgeLoc(item.callSite)}`,
	);
	return [...rows, footer(result.meta)].join("\n");
}

function edgeLoc(edge: CallersOutput[number]["callSite"]): string {
	return `at ${edge.line ?? "?"}:${edge.col ?? "?"}`;
}
