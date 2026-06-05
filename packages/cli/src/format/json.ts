import type { ToolResult } from "@astrograph/core";

export function jsonEnvelope<T>(result: ToolResult<T>): string {
	return JSON.stringify(result);
}
