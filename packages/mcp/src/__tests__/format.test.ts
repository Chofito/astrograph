import { describe, expect, test } from "bun:test";
import type { NodeRef, SearchOutput, ToolResult } from "@astrograph/core";
import { formatSearch } from "../format/search";

describe("MCP formatters", () => {
	test("search formatter is compact text with coverage banner", () => {
		const result: ToolResult<SearchOutput> = {
			data: [{ node: node("makeNodeId"), score: 3.25 }],
			meta: {
				coverage: { total: 2, resolved: 1, parsed: 1, pending: 0 },
				partial: true,
				notes: ["1 file parsed only"],
			},
		};

		expect(formatSearch(result)).toBe(
			[
				"Search",
				"1. makeNodeId [function] packages/core/src/ids.ts:10-20 · score 3.250",
				"",
				"coverage 1/2 resolved · partial: yes · 1 file parsed only",
			].join("\n"),
		);
	});
});

function node(name: string): NodeRef {
	return {
		id: `node:${name}`,
		name,
		kind: "function",
		qualifiedName: `packages/core/src/ids.ts::${name}`,
		filePath: "packages/core/src/ids.ts",
		range: { startLine: 10, endLine: 20, startColumn: 0, endColumn: 1 },
	};
}
