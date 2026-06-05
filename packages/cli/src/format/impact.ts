import type { ImpactOutput, ToolResult } from "@astrograph/core";
import { footer } from "./footer";
import { loc } from "./shared";

export function formatImpact(result: ToolResult<ImpactOutput>): string {
	const rows = result.data.map(
		(item) =>
			`d${item.distance} ${item.node.kind} ${item.node.name}  ${loc(item.node)}`,
	);
	return [...rows, footer(result.meta)].join("\n");
}
