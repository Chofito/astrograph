import { describe, expect, test } from "bun:test";
import { BunSqliteStorageAdapter } from "../adapters/bun/sqlite";
import type { ExtractionError, FileRecord } from "../types";
import { runMigrations } from "./migrations";
import { QueryBuilder } from "./queries";

/**
 * Lifecycle and trust are queried separately. The case that matters most is a
 * `resolved` file that still carries a coverage gap — the pipeline finished,
 * the content is not there.
 */

const NOW = 1_700_000_000_000;

function file(
	path: string,
	state: FileRecord["state"],
	errors?: ExtractionError[],
): FileRecord {
	return {
		path,
		project: "root",
		contentHash: `hash-${path}`,
		language: "typescript",
		size: 10,
		modifiedAt: NOW,
		indexedAt: NOW,
		nodeCount: 0,
		state,
		errors,
	};
}

function withQueries(fn: (queries: QueryBuilder) => void): void {
	const storage = new BunSqliteStorageAdapter(":memory:");
	runMigrations(storage, { now: () => NOW });
	try {
		fn(new QueryBuilder(storage));
	} finally {
		storage.close();
	}
}

describe("trust is queryable independently of lifecycle", () => {
	test("a resolved file can still carry a coverage gap", () => {
		withQueries((queries) => {
			queries.upsertFile(
				file("src/complete.ts", "resolved"),
			);
			queries.upsertFile(
				file("src/blind.ts", "resolved", [
					{
						message: "grammar unavailable",
						severity: "warning",
						code: "TREE_SITTER_GRAMMAR_MISSING",
					},
				]),
			);

			// Lifecycle says both finished.
			expect(queries.getCoverage()).toMatchObject({
				total: 2,
				resolved: 2,
				parsed: 0,
				pending: 0,
			});

			// Trust says one of them cannot answer.
			expect(queries.getFilesWithCoverageGap()).toEqual(["src/blind.ts"]);
		});
	});

	test("a backend defect does not make a file a coverage gap", () => {
		withQueries((queries) => {
			queries.upsertFile(
				file("src/dropped.ts", "resolved", [
					{
						message: "enricher omitted a Pass A node",
						severity: "warning",
						code: "PASS_A_NODE_DROPPED",
					},
				]),
			);

			expect(queries.getFilesWithCoverageGap()).toEqual([]);
			expect(
				queries.getFilesWithDiagnosticCategory("diagnostic").map((s) => s.path),
			).toEqual(["src/dropped.ts"]);
		});
	});

	test("getFilesWithDiagnosticCategory reports state alongside the codes", () => {
		withQueries((queries) => {
			queries.upsertFile(
				file("src/big.ts", "parsed", [
					{
						message: "exceeds maxFileSizeBytes",
						severity: "warning",
						code: "FILE_TOO_LARGE",
					},
				]),
			);

			const summaries = queries.getFilesWithDiagnosticCategory("configuration");
			expect(summaries).toEqual([
				{
					path: "src/big.ts",
					state: "parsed",
					category: "configuration",
					codes: ["FILE_TOO_LARGE"],
					count: 1,
				},
			]);
		});
	});

	test("results are sorted by path and codes deduplicated", () => {
		withQueries((queries) => {
			const twice: ExtractionError[] = [
				{ message: "a", severity: "error", code: "PARSE_ERROR" },
				{ message: "b", severity: "error", code: "PARSE_ERROR" },
			];
			queries.upsertFile(file("src/z.ts", "parsed", twice));
			queries.upsertFile(file("src/a.ts", "parsed", twice));

			const summaries = queries.getFilesWithDiagnosticCategory("coverage_gap");
			expect(summaries.map((s) => s.path)).toEqual(["src/a.ts", "src/z.ts"]);
			expect(summaries[0]?.codes).toEqual(["PARSE_ERROR"]);
			expect(summaries[0]?.count).toBe(2);
		});
	});

	test("counts tally the whole project and can be scoped to paths", () => {
		withQueries((queries) => {
			queries.upsertFile(
				file("src/a.ts", "resolved", [
					{ message: "x", severity: "error", code: "RESOLVE_ERROR" },
				]),
			);
			queries.upsertFile(
				file("src/b.php", "resolved", [
					{ message: "y", severity: "warning", code: "PHP_CALL_UNRESOLVED" },
				]),
			);

			expect(queries.getDiagnosticCounts()).toEqual({
				coverage_gap: 1,
				semantic_uncertainty: 1,
				configuration: 0,
				diagnostic: 0,
			});
			expect(queries.getDiagnosticCounts(["src/b.php"])).toEqual({
				coverage_gap: 0,
				semantic_uncertainty: 1,
				configuration: 0,
				diagnostic: 0,
			});
		});
	});

	test("a successful re-index clears the previous gap", () => {
		withQueries((queries) => {
			queries.upsertFile(
				file("src/a.ts", "parsed", [
					{
						message: "exceeds maxFileSizeBytes",
						severity: "warning",
						code: "FILE_TOO_LARGE",
					},
				]),
			);
			expect(queries.getFilesWithCoverageGap()).toEqual(["src/a.ts"]);

			// The indexer rewrites the record wholesale when Pass A runs again.
			queries.upsertFile(file("src/a.ts", "resolved"));

			expect(queries.getFilesWithCoverageGap()).toEqual([]);
			expect(queries.getDiagnosticCounts()).toEqual({
				coverage_gap: 0,
				semantic_uncertainty: 0,
				configuration: 0,
				diagnostic: 0,
			});
		});
	});

	test("status reports lifecycle and trust side by side", () => {
		withQueries((queries) => {
			queries.upsertFile(
				file("src/blind.ts", "resolved", [
					{
						message: "runtime unavailable",
						severity: "error",
						code: "TREE_SITTER_UNAVAILABLE",
					},
				]),
			);

			const stats = queries.getStats();
			expect(stats.coverage.resolved).toBe(1);
			expect(stats.coverage.pending).toBe(0);
			expect(stats.diagnostics).toMatchObject({ configuration: 1 });
			expect(stats.filesWithCoverageGap).toEqual(["src/blind.ts"]);
		});
	});
});
