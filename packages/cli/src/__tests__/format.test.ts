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

	test("empty callers surfaces the capability reason in the body", async () => {
		const { formatCallers } = await import("../format/callers");
		// Structured, not prose-matched: since AG-206 the formatter reads
		// `reason.kind`, so rewording the detail cannot break the surface.
		const detail = "php backend produces no calls edges";
		const result: ToolResult<[]> = {
			data: [],
			meta: {
				coverage: { total: 1, resolved: 1, parsed: 0, pending: 0 },
				partial: true,
				domain: "global_reverse",
				reasons: [{ kind: "capability_unsupported", detail }],
				notes: [detail],
			},
		};
		expect(formatCallers(result as never)).toContain(`(${detail})`);
	});

	test("a capability reason is detected by kind, not by its wording", async () => {
		const { formatCallers } = await import("../format/callers");
		const result: ToolResult<[]> = {
			data: [],
			meta: {
				coverage: { total: 1, resolved: 1, parsed: 0, pending: 0 },
				partial: true,
				domain: "global_reverse",
				reasons: [
					{ kind: "capability_unsupported", detail: "reworded entirely" },
				],
			},
		};
		expect(formatCallers(result as never)).toContain("(reworded entirely)");
	});

	test("a non-capability reason does not become the empty-result body", async () => {
		const { formatCallers } = await import("../format/callers");
		const result: ToolResult<[]> = {
			data: [],
			meta: {
				coverage: { total: 2, resolved: 1, parsed: 0, pending: 1 },
				partial: true,
				domain: "global_reverse",
				reasons: [
					{ kind: "coverage_incomplete", detail: "1 of 2 files unresolved." },
				],
			},
		};
		expect(formatCallers(result as never)).not.toContain(
			"(1 of 2 files unresolved.)",
		);
	});
});
