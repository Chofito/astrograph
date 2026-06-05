import { describe, expect, test } from "bun:test";
import type { SearchOutput, ToolResult } from "@astrograph/core";
import { footer } from "../format/footer";
import { jsonEnvelope } from "../format/json";
import { formatSearch } from "../format/search";

describe("CLI formatters", () => {
	test("formats search rows with the coverage footer", () => {
		const result: ToolResult<SearchOutput> = {
			data: [
				{
					node: {
						id: "n1",
						name: "helper",
						kind: "function",
						qualifiedName: "src/a.ts::helper",
						filePath: "src/a.ts",
						range: { startLine: 3, endLine: 5, startColumn: 0, endColumn: 1 },
					},
					score: 1,
				},
			],
			meta: {
				coverage: { total: 2, resolved: 2, parsed: 0, pending: 0 },
				partial: false,
			},
		};

		expect(formatSearch(result)).toBe(
			[
				"function helper  src/a.ts:3",
				"coverage 2/2 resolved · partial: no",
			].join("\n"),
		);
	});

	test("formats partial footer details and json envelope exactly", () => {
		const result: ToolResult<SearchOutput> = {
			data: [],
			meta: {
				coverage: { total: 3, resolved: 1, parsed: 1, pending: 1 },
				partial: true,
				pendingFiles: ["src/pending.ts"],
				notes: ["1 unresolved edge included"],
			},
		};

		expect(footer(result.meta)).toBe(
			"coverage 1/3 resolved · partial: yes · pending: src/pending.ts · notes: 1 unresolved edge included",
		);
		expect(jsonEnvelope(result)).toBe(JSON.stringify(result));
	});
});
