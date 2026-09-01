import { describe, expect, test } from "bun:test";
import { BunSqliteStorageAdapter } from "../adapters/bun/sqlite";
import { runMigrations } from "../db/migrations";
import { QueryBuilder } from "../db/queries";
import type { BackendStatus, FileRecord } from "../types";
import { buildMeta } from "./meta";

/**
 * AG-206: `partial` reflects the query's completeness domain, not the files the
 * payload happened to contain. A reverse lookup that found nothing returns no
 * files, so scoping coverage to the payload would report "nothing calls this"
 * with `partial: false`.
 */

const NOW = 1_700_000_000_000;

function file(
	path: string,
	state: FileRecord["state"],
	overrides: Partial<FileRecord> = {},
): FileRecord {
	return {
		path,
		project: "root",
		contentHash: `h-${path}`,
		language: path.endsWith(".php") ? "php" : "typescript",
		size: 10,
		modifiedAt: NOW,
		indexedAt: NOW,
		nodeCount: 1,
		state,
		...overrides,
	};
}

const TS_FULL: BackendStatus = {
	id: "typescript",
	languages: ["typescript"],
	extensions: [".ts"],
	versions: {},
	enricher: "complement",
	capabilities: { edgeKinds: ["contains", "calls", "references"] },
	grammarsLoaded: [],
	grammarsUnavailable: [],
};

const PHP_PASS_A_ONLY: BackendStatus = {
	id: "php",
	languages: ["php"],
	extensions: [".php"],
	versions: {},
	enricher: "none",
	capabilities: { edgeKinds: ["contains"] },
	grammarsLoaded: [],
	grammarsUnavailable: [],
};

function withQueries(fn: (queries: QueryBuilder) => void): void {
	const storage = new BunSqliteStorageAdapter(":memory:");
	runMigrations(storage, { now: () => NOW });
	try {
		fn(new QueryBuilder(storage));
	} finally {
		storage.close();
	}
}

describe("domain decides what completeness means", () => {
	test("a fully resolved project answers a global question completely", () => {
		withQueries((queries) => {
			queries.upsertFile(file("src/a.ts", "resolved"));
			const meta = buildMeta(queries, {
				domain: { domain: "global_reverse", requiredEdgeKinds: ["calls"] },
				backends: [TS_FULL],
			});
			expect(meta.partial).toBe(false);
			expect(meta.domain).toBe("global_reverse");
			expect(meta.reasons).toBeUndefined();
		});
	});

	test("a pending file anywhere makes a global reverse answer partial", () => {
		withQueries((queries) => {
			queries.upsertFile(file("src/a.ts", "resolved"));
			queries.upsertFile(file("src/unread.ts", "pending"));

			const meta = buildMeta(queries, {
				domain: { domain: "global_reverse", requiredEdgeKinds: ["calls"] },
				backends: [TS_FULL],
			});

			expect(meta.partial).toBe(true);
			expect(meta.reasons?.map((r) => r.kind)).toContain("coverage_incomplete");
		});
	});

	test("a truly local question stays complete despite an unrelated problem", () => {
		withQueries((queries) => {
			queries.upsertFile(file("src/a.ts", "resolved"));
			queries.upsertFile(file("src/unrelated.ts", "pending"));

			const meta = buildMeta(queries, {
				domain: {
					domain: "local_outgoing",
					scopeFiles: ["src/a.ts"],
					requiredEdgeKinds: ["calls"],
					sourceLanguage: "typescript",
				},
				backends: [TS_FULL],
			});

			expect(meta.partial).toBe(false);
		});
	});

	test("status describes state instead of hiding it behind partial", () => {
		withQueries((queries) => {
			queries.upsertFile(file("src/unread.ts", "pending"));
			const meta = buildMeta(queries, { domain: { domain: "descriptive" } });
			expect(meta.partial).toBe(false);
			expect(meta.coverage.pending).toBe(1);
		});
	});
});

describe("resolved does not mean complete (AG-201 feeding AG-206)", () => {
	test("a resolved file with a coverage gap still makes a global answer partial", () => {
		withQueries((queries) => {
			queries.upsertFile(
				file("src/blind.ts", "resolved", {
					errors: [
						{
							message: "grammar unavailable",
							severity: "warning",
							code: "TREE_SITTER_GRAMMAR_MISSING",
						},
					],
				}),
			);

			const meta = buildMeta(queries, {
				domain: { domain: "global_discovery" },
				backends: [TS_FULL],
			});

			// Lifecycle says complete; trust says otherwise.
			expect(meta.coverage.resolved).toBe(1);
			expect(meta.coverage.pending).toBe(0);
			expect(meta.partial).toBe(true);
			expect(meta.reasons?.some((r) => r.files?.includes("src/blind.ts"))).toBe(
				true,
			);
		});
	});

	test("a backend defect alone does not make an answer partial", () => {
		withQueries((queries) => {
			queries.upsertFile(
				file("src/a.ts", "resolved", {
					errors: [
						{
							message: "enricher omitted a Pass A node",
							severity: "warning",
							code: "PASS_A_NODE_DROPPED",
						},
					],
				}),
			);

			const meta = buildMeta(queries, {
				domain: { domain: "global_discovery" },
				backends: [TS_FULL],
			});
			expect(meta.partial).toBe(false);
		});
	});
});

describe("capability evaluation follows the direction of the question", () => {
	test("a reverse question consults every backend with files", () => {
		withQueries((queries) => {
			queries.upsertFile(file("src/a.ts", "resolved"));
			queries.upsertFile(file("src/B.php", "resolved"));

			const meta = buildMeta(queries, {
				domain: { domain: "global_reverse", requiredEdgeKinds: ["calls"] },
				backends: [TS_FULL, PHP_PASS_A_ONLY],
			});

			// A PHP caller could exist and would be invisible, so a negative
			// TypeScript answer cannot claim to be complete.
			expect(meta.partial).toBe(true);
			expect(
				meta.reasons?.filter((r) => r.kind === "capability_unsupported").length,
			).toBe(1);
		});
	});

	test("a backend with no files in the project penalizes nothing", () => {
		withQueries((queries) => {
			// PHP is registered but this repository has no PHP.
			queries.upsertFile(file("src/a.ts", "resolved"));

			const meta = buildMeta(queries, {
				domain: { domain: "global_reverse", requiredEdgeKinds: ["calls"] },
				backends: [TS_FULL, PHP_PASS_A_ONLY],
			});

			expect(meta.partial).toBe(false);
			expect(meta.reasons).toBeUndefined();
		});
	});

	test("an outgoing question consults only the source's backend", () => {
		withQueries((queries) => {
			queries.upsertFile(file("src/a.ts", "resolved"));
			queries.upsertFile(file("src/B.php", "resolved"));

			const meta = buildMeta(queries, {
				domain: {
					domain: "local_outgoing",
					scopeFiles: ["src/a.ts"],
					requiredEdgeKinds: ["calls"],
					sourceLanguage: "typescript",
				},
				backends: [TS_FULL, PHP_PASS_A_ONLY],
			});

			// PHP's missing capability cannot hide a TypeScript symbol's own callees.
			expect(meta.partial).toBe(false);
		});
	});

	test("a Pass-A-only source backend does produce a capability note", () => {
		withQueries((queries) => {
			queries.upsertFile(file("src/B.php", "resolved"));

			const meta = buildMeta(queries, {
				domain: {
					domain: "local_outgoing",
					scopeFiles: ["src/B.php"],
					requiredEdgeKinds: ["calls"],
					sourceLanguage: "php",
				},
				backends: [TS_FULL, PHP_PASS_A_ONLY],
			});

			expect(meta.partial).toBe(true);
			expect(meta.reasons?.[0]?.kind).toBe("capability_unsupported");
		});
	});
});

describe("reason kinds are distinguishable and ordered", () => {
	test("truncation is its own kind, not folded into coverage", () => {
		withQueries((queries) => {
			queries.upsertFile(file("src/a.ts", "resolved"));
			const meta = buildMeta(queries, {
				domain: { domain: "global_discovery", truncated: true },
				backends: [TS_FULL],
			});
			expect(meta.reasons?.map((r) => r.kind)).toEqual(["search_truncated"]);
			expect(meta.partial).toBe(true);
		});
	});

	test("reasons are deterministically ordered and mirrored into notes", () => {
		withQueries((queries) => {
			queries.upsertFile(file("src/pending.ts", "pending"));
			queries.upsertFile(file("src/B.php", "resolved"));

			const meta = buildMeta(queries, {
				domain: {
					domain: "global_reverse",
					requiredEdgeKinds: ["calls"],
					truncated: true,
				},
				backends: [TS_FULL, PHP_PASS_A_ONLY],
			});

			expect(meta.reasons?.map((r) => r.kind)).toEqual([
				"coverage_incomplete",
				"capability_unsupported",
				"search_truncated",
			]);
			// CLI and MCP both render `notes`, so they carry identical facts.
			expect(meta.notes).toEqual(meta.reasons?.map((r) => r.detail));
		});
	});
});
