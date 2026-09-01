import type { CallersOutput, ToolResult } from "@astrograph/core";
import { footer } from "./footer";
import { loc } from "./shared";

export function formatCallers(result: ToolResult<CallersOutput>): string {
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
						`${item.caller.kind} ${item.caller.name}  ${loc(item.caller)}  ${edgeLoc(item.callSite)}`,
				);
	return [...rows, footer(result.meta)].join("\n");
}

function edgeLoc(edge: CallersOutput[number]["callSite"]): string {
	return `at ${edge.line ?? "?"}:${edge.col ?? "?"}`;
}
