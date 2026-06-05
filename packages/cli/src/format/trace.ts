import type { ToolResult, TraceOutput } from "@astrograph/core";
import { footer } from "./footer";
import { loc } from "./shared";

export function formatTrace(result: ToolResult<TraceOutput>): string {
	const lines = [result.data.found ? "path found" : "no path found"];
	if (result.data.found) {
		for (const hop of result.data.hops) {
			lines.push(
				`${hop.node.name} --${hop.via.kind}--> ${hop.via.targetName ?? hop.via.target ?? "?"}`,
			);
			lines.push(`${loc(hop.node)}`);
			lines.push(hop.body.content);
		}
		if (
			result.data.destinationCallees !== undefined &&
			result.data.destinationCallees.length > 0
		) {
			lines.push(
				`destination callees ${result.data.destinationCallees.map((node) => node.name).join(", ")}`,
			);
		}
	} else {
		for (const endpoint of result.data.endpoints ?? []) {
			lines.push(
				`${endpoint.node.kind} ${endpoint.node.name}  ${loc(endpoint.node)}`,
			);
			lines.push(endpoint.body.content);
		}
	}
	lines.push(footer(result.meta));
	return lines.join("\n");
}
