import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { BunSqliteStorageAdapter } from "../../src/adapters/bun/sqlite";
import { categoryOf } from "../../src/diagnostics";
import type { NormalizedIndex } from "../../src/testing/normalize";
import { expectMatchesGolden } from "./assert";
import {
	FAILURE_BACKEND_DISABLED_MANIFEST,
	FAILURE_BACKEND_EXTRACTION_MANIFEST,
	FAILURE_BACKEND_EXTRACTION_PASS_A_MANIFEST,
	FAILURE_CAPABILITY_GAP_MANIFEST,
	FAILURE_COVERAGE_GAPS_MANIFEST,
	FAILURE_GRAMMAR_MISSING_MANIFEST,
	FAILURE_MANIFESTS,
	FAILURE_UNOWNED_AND_DISABLED_MANIFEST,
} from "./failure-fixtures";
import { GRAMMARLESS_EXTENSION } from "./failure-injection";
import { PipelineSession, runCleanPipeline, withPipeline } from "./harness";

/**
 * AG-306: failures stay visible, and honesty is per domain.
 *
 * Every assertion here names a structured code or state. None of them matches
 * message prose: the code is the contract and the message is for humans, so a
 * test that asserted wording would fail on a copy-edit and pass on a
 * re-categorization — exactly backwards.
 */

/**
 * Every test in this file runs real indexing — a TypeScript program, tree-sitter
 * parses and a SQLite database per pipeline — so the explicit timeouts below are
 * headroom for a loaded machine, not permission to be slow. Bun's 5 s default
 * left the four-route rows failing on contention alone while they were doing
 * about two seconds of genuine work.
 */
const PIPELINE_TEST_TIMEOUT_MS = 60_000;

function fileRecord(graph: NormalizedIndex, suffix: string) {
	return graph.files.find((file) => file.path.endsWith(suffix));
}

function codesFor(graph: NormalizedIndex, suffix: string): string[] {
	return (fileRecord(graph, suffix)?.errors ?? [])
		.map((error) => error.code ?? "")
		.sort();
}

describe("failure goldens", () => {
	for (const manifest of FAILURE_MANIFESTS) {
		test(
			`${manifest.id} matches its reviewed golden`,
			async () => {
				await expectMatchesGolden(
					manifest.id,
					await runCleanPipeline(manifest),
				);
			},
			PIPELINE_TEST_TIMEOUT_MS,
		);
	}
});

describe("every failure leaves attributable persisted evidence", () => {
	test(
		"an oversized owned file keeps a record, no nodes and a reason",
		async () => {
			const { graph } = await runCleanPipeline(FAILURE_COVERAGE_GAPS_MANIFEST);
			const oversized = fileRecord(graph, "src/oversized.ts");

			// The record survives — deleting it would make the file invisible rather
			// than known-and-skipped — and it holds nothing the graph cannot back up.
			expect(oversized).toBeDefined();
			expect(oversized?.nodeCount).toBe(0);
			expect(codesFor(graph, "src/oversized.ts")).toEqual(["FILE_TOO_LARGE"]);
			expect(
				graph.nodes.filter((node) => node.filePath === "src/oversized.ts"),
			).toEqual([]);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"an owned extension with no grammar yields a file node and says why",
		async () => {
			const { graph } = await runCleanPipeline(FAILURE_COVERAGE_GAPS_MANIFEST);
			const path = `src/shader${GRAMMARLESS_EXTENSION}`;

			// Pass A still emits the file node: the file exists and is owned. What it
			// cannot do is claim any structure inside it.
			expect(codesFor(graph, path)).toEqual(["TREE_SITTER_UNAVAILABLE"]);
			const nodes = graph.nodes.filter((node) => node.filePath === path);
			expect(nodes.map((node) => node.kind)).toEqual(["file"]);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a backend Pass A failure survives as a diagnostic even when the enricher recovers",
		async () => {
			const { graph } = await runCleanPipeline(
				FAILURE_BACKEND_EXTRACTION_MANIFEST,
			);

			// The enricher is a *complement*: its own node view is reconciled onto
			// Pass A's, so a file whose Pass A produced nothing still gets nodes from
			// the compiler. What must not happen is the diagnostic disappearing along
			// with the problem — a recovered file is not an unaffected one.
			expect(codesFor(graph, "src/broken.ts")).toEqual(["PARSE_ERROR"]);
			expect(
				fileRecord(graph, "src/broken.ts")?.nodeCount ?? 0,
			).toBeGreaterThan(0);

			// And the category is the one the taxonomy assigns, so a consumer can tell
			// "we know nothing about this file" from "this relation is uncertain".
			expect(categoryOf("PARSE_ERROR")).toBe("coverage_gap");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"with no enricher behind it, the same failure leaves a visibly empty file",
		async () => {
			const { graph } = await runCleanPipeline(
				FAILURE_BACKEND_EXTRACTION_PASS_A_MANIFEST,
			);

			// Nothing recovers this file: owned, eligible, enabled and empty. The
			// record and its code are the only thing standing between that state and
			// an index that reports success over a file it knows nothing about.
			expect(codesFor(graph, "src/broken.ts")).toEqual(["PARSE_ERROR"]);
			expect(fileRecord(graph, "src/broken.ts")?.nodeCount).toBe(0);
			expect(
				graph.nodes.filter((node) => node.filePath === "src/broken.ts"),
			).toEqual([]);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"an unowned extension and a disabled backend are both recorded when `include` names them",
		async () => {
			const { graph, envelopes } = await runCleanPipeline(
				FAILURE_UNOWNED_AND_DISABLED_MANIFEST,
			);

			// Same code, two different classifications, and the message is what
			// distinguishes them. The code stays the contract — a consumer that
			// needs to act reads `NO_BACKEND` — while the message is what tells a
			// human whether to install a backend or re-enable one.
			expect(codesFor(graph, "notes.txt")).toEqual(["NO_BACKEND"]);
			expect(codesFor(graph, "src/Service.php")).toEqual(["NO_BACKEND"]);
			const disabled = fileRecord(graph, "src/Service.php")?.errors[0];
			expect(disabled?.message).toContain("disabled");
			expect(fileRecord(graph, "notes.txt")?.errors[0]?.message).not.toContain(
				"disabled",
			);

			// Neither file contributes graph content, and neither is silently
			// forgotten.
			expect(fileRecord(graph, "notes.txt")?.nodeCount).toBe(0);
			expect(
				graph.nodes.filter((node) => node.filePath === "src/Service.php"),
			).toEqual([]);

			// And because the records exist, the envelopes are honest: a global
			// question is partial with a coverage reason, while the local answer
			// inside the healthy file stays complete.
			const callers = envelopes["callers:helper"];
			expect(callers && "partial" in callers && callers.partial).toBe(true);
			const callees = envelopes["callees:useHelper"];
			expect(callees && "partial" in callees && callees.partial).toBe(false);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a disabled backend retires its nodes and keeps an actionable record",
		async () => {
			await withPipeline(
				{ ...FAILURE_BACKEND_DISABLED_MANIFEST, run: undefined },
				async (session) => {
					await session.indexAll();
					const before = session.snapshotGraph();
					const retiredIds = new Set(
						before.nodes
							.filter((node) => node.filePath === "src/Service.php")
							.map((node) => node.id),
					);
					// Guard: retirement can only be proven against facts that existed.
					// Node ids are decimal hashes, so a substring of `Service` on
					// `edge.source` would never match and the assertion would be vacuous.
					expect(retiredIds.size).toBeGreaterThan(0);

					await session.reopen({
						modes: { typescript: "enriched", php: "disabled" },
					});
					await session.indexAll();
					const after = await session.snapshot(
						FAILURE_BACKEND_DISABLED_MANIFEST.probes ?? [],
					);

					expect(
						after.graph.nodes.filter(
							(node) => node.filePath === "src/Service.php",
						),
					).toEqual([]);
					expect(
						after.graph.edges.filter(
							(edge) =>
								retiredIds.has(edge.source) ||
								(edge.target !== null && retiredIds.has(edge.target)),
						),
					).toEqual([]);

					const remainingIds = new Set(
						after.graph.nodes.map((node) => node.id),
					);
					expect(
						after.graph.edges.filter(
							(edge) =>
								!remainingIds.has(edge.source) ||
								(edge.target !== null && !remainingIds.has(edge.target)),
						),
					).toEqual([]);

					// And the row survives with the reason. This is the regression
					// guard for the gap this fixture used to document: the scanner
					// covers every shipped backend's extensions, so membership
					// classifies the path `backend_disabled` instead of dropping it
					// as `out_of_scope`.
					const record = fileRecord(after.graph, "src/Service.php");
					expect(record).toBeDefined();
					expect(record?.nodeCount).toBe(0);
					expect(codesFor(after.graph, "src/Service.php")).toEqual([
						"NO_BACKEND",
					]);
					expect(record?.errors[0]?.message).toContain("disabled");

					// The healthy file is untouched by its neighbour's retirement.
					expect(fileRecord(after.graph, "src/ok.ts")?.errors).toEqual([]);

					// The envelopes are now honest: a project half of which is
					// unindexed no longer answers a global question with
					// `partial: false`, while the local answer inside the healthy
					// file stays complete.
					const search = after.envelopes["search:handle"];
					expect(search && "partial" in search && search.partial).toBe(true);
					const callers = after.envelopes["callers:helper"];
					expect(
						callers && "partial" in callers && callers.partial,
					).toBe(true);
					const callees = after.envelopes["callees:useHelper"];
					expect(
						callees && "partial" in callees && callees.partial,
					).toBe(false);
				},
			);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a recognized extension whose grammar is missing keeps a file-only node",
		async () => {
			const { graph, envelopes } = await runCleanPipeline(
				FAILURE_GRAMMAR_MISSING_MANIFEST,
			);

			expect(codesFor(graph, "src/gapped.ts")).toEqual([
				"TREE_SITTER_GRAMMAR_MISSING",
			]);
			expect(categoryOf("TREE_SITTER_GRAMMAR_MISSING")).toBe("configuration");

			const gapped = graph.nodes.filter(
				(node) => node.filePath === "src/gapped.ts",
			);
			expect(gapped.map((node) => node.kind)).toEqual(["file"]);
			expect(
				graph.edges.filter((edge) =>
					gapped.some((node) => node.id === edge.source),
				),
			).toEqual([]);

			const record = fileRecord(graph, "src/gapped.ts");
			expect(record).toBeDefined();
			expect(record?.nodeCount).toBe(1);

			expect(fileRecord(graph, "src/ok.ts")?.errors).toEqual([]);
			expect(
				graph.nodes.some(
					(node) =>
						node.filePath === "src/ok.ts" && node.kind === "function",
				),
			).toBe(true);

			// Pass-A-only so the enricher cannot recover structure and hide the
			// file-only contract. Global questions therefore report both the
			// missing grammar (coverage) and the missing enricher (capability).
			// `useHelper`'s local domain is only `src/ok.ts`, so it must not
			// blame `gapped.ts` — that would make partiality meaningless.
			const callers = envelopes["callers:helper"];
			expect(callers && "partial" in callers && callers.partial).toBe(true);
			const callerKinds =
				callers && "reasons" in callers
					? (callers.reasons ?? []).map((reason) => reason.kind)
					: [];
			expect(callerKinds).toContain("coverage_incomplete");
			expect(callerKinds).toContain("capability_unsupported");
			expect(
				callers &&
					"reasons" in callers &&
					(callers.reasons ?? []).some(
						(reason) =>
							reason.kind === "coverage_incomplete" &&
							reason.files?.includes("src/gapped.ts") === true,
					),
			).toBe(true);

			const callees = envelopes["callees:useHelper"];
			expect(callees && "partial" in callees && callees.partial).toBe(true);
			expect(
				callees &&
					"reasons" in callees &&
					(callees.reasons ?? []).map((reason) => reason.kind),
			).toEqual(["capability_unsupported"]);

			const status = envelopes.status;
			expect(status && "partial" in status && status.partial).toBe(false);
			expect(status && "domain" in status && status.domain).toBe(
				"descriptive",
			);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"unresolved and ambiguous relations are kept as evidence",
		async () => {
			const { graph } = await runCleanPipeline(FAILURE_COVERAGE_GAPS_MANIFEST);

			const unresolved = graph.edges.filter(
				(edge) => edge.resolutionState === "unresolved",
			);
			const ambiguous = graph.edges.filter(
				(edge) => edge.resolutionState === "ambiguous",
			);
			expect(unresolved.length + ambiguous.length).toBeGreaterThan(0);

			// Unresolved means no node id at all — only the text the source wrote.
			expect(unresolved.every((edge) => edge.target === null)).toBe(true);

			// Ambiguous is a different claim, and its evidence is different too: a
			// target *is* recorded, and the alternatives it was chosen from are
			// listed. Collapsing the two states would either hide the alternatives or
			// throw away a usable answer.
			expect(ambiguous.length).toBeGreaterThan(0);
			for (const edge of ambiguous) {
				const candidates = edge.metadata?.candidates;
				expect(Array.isArray(candidates)).toBe(true);
				expect((candidates as unknown[]).length).toBeGreaterThan(1);
			}

			expect(
				[...unresolved, ...ambiguous].every(
					(edge) => (edge.targetName ?? "").length > 0,
				),
			).toBe(true);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("the grammar runtime failing is a different failure", () => {
	test(
		"an initialization failure keeps the project from opening at all",
		async () => {
			// Per-extension grammar absence degrades one file — that is the
			// `TREE_SITTER_UNAVAILABLE` row above. `initTreeSitter` failing is not a
			// per-file condition: no backend can parse anything, and `openProject`
			// propagates it rather than opening a project that would quietly index
			// every file as empty.
			//
			// The seam is used instead of the real runtime because the grammar cache
			// is process-global: making it genuinely fail here would break every
			// other fixture in the same test run.
			let root = "";
			await expect(
				PipelineSession.open({
					...FAILURE_CAPABILITY_GAP_MANIFEST,
					id: "failure-grammar-initialization",
					injection: {
						async loadGrammars() {
							throw new Error("tree-sitter runtime unavailable");
						},
						createStorage: (path) => {
							root = path.slice(0, path.indexOf("/.astrograph"));
							return new BunSqliteStorageAdapter(path);
						},
					},
				}),
			).rejects.toThrow("tree-sitter runtime unavailable");

			// And the failure releases what it allocated: `openProject` closes the
			// SQLite handle it opened, the harness removes the temporary tree.
			expect(root.length).toBeGreaterThan(0);
			expect(existsSync(root)).toBe(false);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("query honesty is decided per domain", () => {
	test(
		"a local answer stays complete inside a degraded project",
		async () => {
			await withPipeline(FAILURE_COVERAGE_GAPS_MANIFEST, async (session) => {
				await session.indexAll();

				// The project has an oversized file, a grammarless file and unproven
				// relations. None of them is in the domain of "what does useHelper
				// call", and marking this partial would make partiality meaningless.
				const callees = await session.astrograph.callees({
					symbol: "useHelper",
				});
				expect(callees.data.map((entry) => entry.callee.name)).toEqual([
					"helper",
				]);
				expect(callees.meta.domain).toBe("local_outgoing");
				expect(callees.meta.partial).toBe(false);

				// Meanwhile the same index answers a global question partially, with
				// structured reasons that name the files responsible.
				const callers = await session.astrograph.callers({ symbol: "helper" });
				expect(callers.meta.domain).toBe("global_reverse");
				expect(callers.meta.partial).toBe(true);
				expect(
					(callers.meta.reasons ?? []).map((reason) => reason.kind),
				).toContain("coverage_incomplete");
			});
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"status describes the damage instead of hiding behind partial",
		async () => {
			await withPipeline(FAILURE_COVERAGE_GAPS_MANIFEST, async (session) => {
				await session.indexAll();
				const status = await session.astrograph.getStats({});

				// `descriptive` is the one domain that must never be partial: its whole
				// job is to report the state other domains are reacting to.
				expect(status.meta.domain).toBe("descriptive");
				expect(status.meta.partial).toBe(false);
				expect(status.data.fileCount).toBeGreaterThan(0);
			});
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a capability gap is not reported as a coverage gap",
		async () => {
			await withPipeline(FAILURE_CAPABILITY_GAP_MANIFEST, async (session) => {
				await session.indexAll();

				// Nothing is wrong with this project: every file parsed cleanly. What is
				// missing is an ability, and conflating the two would tell the user to
				// re-index when they need to turn the enricher on.
				const graph = session.snapshotGraph();
				expect(graph.files.flatMap((file) => file.errors)).toEqual([]);

				const callers = await session.astrograph.callers({ symbol: "helper" });
				const kinds = (callers.meta.reasons ?? []).map((reason) => reason.kind);
				expect(kinds).toContain("capability_unsupported");
				expect(kinds).not.toContain("coverage_incomplete");

				// And discovery, which needs no edge kind at all, is complete.
				const search = await session.astrograph.search({ query: "helper" });
				expect(search.meta.partial).toBe(false);
			});
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"no unresolved target reaches a node-shaped payload",
		async () => {
			await withPipeline(FAILURE_COVERAGE_GAPS_MANIFEST, async (session) => {
				await session.indexAll();

				// `describePath` calls `join`, which is not in the project. The callee
				// list may not invent a node for it; the relation belongs in evidence.
				const callees = await session.astrograph.callees({
					symbol: "describePath",
				});
				expect(callees.data.map((entry) => entry.callee.name)).not.toContain(
					"join",
				);
				expect(callees.meta.evidence).toBeDefined();
			});
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});
