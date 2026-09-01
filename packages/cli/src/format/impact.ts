import type { ImpactOutput, ToolResult } from "@astrograph/core";
import { footer } from "./footer";
import { loc } from "./shared";

export function formatImpact(result: ToolResult<ImpactOutput>): string {
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
						`d${item.distance} ${item.node.kind} ${item.node.name}  ${loc(item.node)}`,
				);
	return [...rows, footer(result.meta)].join("\n");
}
