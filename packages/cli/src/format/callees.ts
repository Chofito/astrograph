import type { CalleesOutput, ToolResult } from "@astrograph/core";
import { footer } from "./footer";
import { loc } from "./shared";

export function formatCallees(result: ToolResult<CalleesOutput>): string {
	// Structured, not substring-matched: the reason kind is the contract and the
	// detail is prose that may be reworded at any time (AG-206).
	const capability = result.meta.reasons?.find(
		(reason) => reason.kind === "capability_unsupported",
	)?.detail;
	const rows =
		result.data.length === 0 && capability !== undefined
			? [`(${capability})`]
			: result.data.map(
					(item) =>
						`${item.callee.kind} ${item.callee.name}  ${loc(item.callee)}  ${edgeLoc(item.callSite)}`,
				);
	return [...rows, footer(result.meta)].join("\n");
}

function edgeLoc(edge: CalleesOutput[number]["callSite"]): string {
	return `at ${edge.line ?? "?"}:${edge.col ?? "?"}`;
}
