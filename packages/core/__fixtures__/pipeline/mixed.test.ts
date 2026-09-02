import { describe, expect, test } from "bun:test";
import type { NormalizedIndex } from "../../src/testing/normalize";
import { assertNoDiscrepancies, expectMatchesGolden } from "./assert";
import { compareGraphs } from "./compare";
import { runCleanPipeline, withPipeline } from "./harness";
import {
	MIXED_ENRICHED_MANIFEST,
	MIXED_MANIFESTS,
	MIXED_PHP_PASS_A_MANIFEST,
	MIXED_TS_ONLY_MANIFEST,
	MIXED_TS_PASS_A_MANIFEST,
} from "./mixed-fixtures";

/**
 * AG-305: exclusive ownership, deterministic isolation, and the 0.1.0
 * cross-language boundary.
 *
 * The claim under test is negative as much as positive: two backends index one
 * project, each owns its own paths, and *neither* may resolve into the other.
 * A generic name-based bridge would satisfy every ordinary test in the suite
 * and quietly invent relations that do not exist.
 */

/**
 * Every test in this file runs real indexing — a TypeScript program, tree-sitter
 * parses and a SQLite database per pipeline — so the explicit timeouts below are
 * headroom for a loaded machine, not permission to be slow. Bun's 5 s default
 * left the four-route rows failing on contention alone while they were doing
 * about two seconds of genuine work.
 */
const PIPELINE_TEST_TIMEOUT_MS = 60_000;
/** The rows that run every route, or every row, need more of it. */
const MATRIX_TEST_TIMEOUT_MS = 300_000;

const PHP_PATHS = ["src/php/Consumer.php", "src/php/Handler.php"];
const TS_PATHS = ["src/js/consumer.ts", "src/js/handler.ts"];

/** Rows the given backend's proof produced, by the file they belong to. */
function ownedBy(graph: NormalizedIndex, paths: readonly string[]) {
	const nodes = graph.nodes.filter((node) => paths.includes(node.filePath));
	const nodeIds = new Set(nodes.map((node) => node.id));
	return {
		nodes,
		edges: graph.edges.filter((edge) => nodeIds.has(edge.source)),
	};
}

describe("mixed-language goldens", () => {
	for (const manifest of MIXED_MANIFESTS) {
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

describe("ownership is exclusive", () => {
	test(
		"every file has exactly one owning backend",
		async () => {
			const { graph } = await runCleanPipeline(MIXED_ENRICHED_MANIFEST);

			// The registry maps extension → backend, and the language recorded on the
			// file record is that decision. No path may appear twice, and no path may
			// be recorded under the other language.
			const byPath = new Map(
				graph.files.map((file) => [file.path, file.language]),
			);
			expect(byPath.size).toBe(graph.files.length);
			for (const path of PHP_PATHS) expect(byPath.get(path)).toBe("php");
			for (const path of TS_PATHS) expect(byPath.get(path)).toBe("typescript");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"homonymous declarations stay distinct",
		async () => {
			const { graph } = await runCleanPipeline(MIXED_ENRICHED_MANIFEST);

			for (const name of ["process", "invoke"]) {
				const declarations = graph.nodes.filter((node) => node.name === name);
				const languages = new Set(declarations.map((node) => node.language));
				expect(languages).toEqual(new Set(["typescript", "php"]));
				// Distinct ids, because the id hashes the file path: one name, two
				// symbols, and a query that returns both must be able to tell them apart.
				expect(new Set(declarations.map((node) => node.id)).size).toBe(
					declarations.length,
				);
			}
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"no relation crosses the language boundary",
		async () => {
			const { graph } = await runCleanPipeline(MIXED_ENRICHED_MANIFEST);
			const languageOf = new Map(
				graph.nodes.map((node) => [node.id, node.language]),
			);

			// Guard: an empty edge set crosses no boundary either.
			expect(graph.edges.length).toBeGreaterThan(0);
			expect(
				graph.edges.filter((edge) => edge.target !== null).length,
			).toBeGreaterThan(0);

			const crossing = graph.edges.filter((edge) => {
				if (edge.target === null || edge.target === undefined) return false;
				const source = languageOf.get(edge.source);
				const target = languageOf.get(edge.target);
				return (
					source !== undefined && target !== undefined && source !== target
				);
			});
			expect(crossing).toEqual([]);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a name that exists only in the other language stays unresolved",
		async () => {
			const { graph } = await runCleanPipeline(MIXED_ENRICHED_MANIFEST);

			// `handle` is a PHP method; `src/js/consumer.ts` calls it on a structural
			// type. `compute` is a TypeScript function; `Consumer::stray` calls it on
			// an untyped variable. Both are name matches across languages.
			for (const targetName of ["handle", "compute"]) {
				const edges = graph.edges.filter(
					(edge) => edge.targetName === targetName && edge.kind === "calls",
				);
				expect(edges.length).toBeGreaterThan(0);
				expect(edges.every((edge) => edge.resolutionState !== "resolved")).toBe(
					true,
				);
				expect(edges.every((edge) => edge.target === null)).toBe(true);
			}
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"each language resolves its own homonym, not the other's",
		async () => {
			const { graph } = await runCleanPipeline(MIXED_ENRICHED_MANIFEST);
			const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

			// PHP `Handler::invoke` calls PHP `process`; TS `invoke` calls TS
			// `process`. Same two names, two entirely separate resolutions.
			const resolvedProcessCalls = graph.edges.filter(
				(edge) =>
					edge.kind === "calls" &&
					edge.targetName === "process" &&
					edge.resolutionState === "resolved",
			);
			expect(resolvedProcessCalls.length).toBe(2);
			for (const edge of resolvedProcessCalls) {
				const source = nodeById.get(edge.source);
				const target = nodeById.get(edge.target ?? "");
				expect(target?.language).toBe(source?.language);
			}
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("disabling and re-enabling a backend", () => {
	test(
		"disabling PHP retires only PHP facts and explains the rest",
		async () => {
			await withPipeline(MIXED_ENRICHED_MANIFEST, async (session) => {
				await session.indexAll();
				const before = session.snapshotGraph();

				// Guard: retirement can only be proven against facts that existed.
				// Without this, a PHP half that silently indexed nothing would make
				// every assertion below vacuously true.
				expect(ownedBy(before, PHP_PATHS).nodes.length).toBeGreaterThan(0);
				expect(ownedBy(before, PHP_PATHS).edges.length).toBeGreaterThan(0);

				await session.reopen({
					modes: { typescript: "enriched", php: "disabled" },
				});
				await session.indexAll();
				const after = session.snapshotGraph();

				// Nothing PHP-owned survives as graph content …
				expect(ownedBy(after, PHP_PATHS).nodes).toEqual([]);
				expect(ownedBy(after, PHP_PATHS).edges).toEqual([]);

				// … and each path stays in the file table with the reason, so "PHP is
				// turned off" is distinguishable from "this project has no PHP". The
				// scanner covers every *shipped* backend's extensions, enabled or
				// not, which is what lets membership classify these
				// `backend_disabled` instead of dropping them as `out_of_scope`.
				for (const path of PHP_PATHS) {
					const record = after.files.find((file) => file.path === path);
					expect(record?.nodeCount).toBe(0);
					expect((record?.errors ?? []).map((error) => error.code)).toEqual([
						"NO_BACKEND",
					]);
					expect(record?.errors[0]?.message).toContain("disabled");
				}

				// And the TypeScript half is byte-identical to what it was, because
				// none of its facts depended on PHP.
				assertNoDiscrepancies(
					compareGraphs(
						{ ...ownedBy(after, TS_PATHS), files: [] },
						{ ...ownedBy(before, TS_PATHS), files: [] },
					),
					"TypeScript facts after disabling PHP",
				);
			});
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"the TypeScript half equals a project that never had PHP",
		async () => {
			// The reference is a clean index with PHP off from the start. Both
			// projects now record the same `.php` paths as unindexed evidence, so
			// what this isolates is the graph *content* owned by TypeScript: it must
			// be identical whether or not PHP files are present and indexed.
			const [mixed, tsOnly] = await Promise.all([
				runCleanPipeline(MIXED_ENRICHED_MANIFEST),
				runCleanPipeline(MIXED_TS_ONLY_MANIFEST),
			]);

			assertNoDiscrepancies(
				compareGraphs(
					{ ...ownedBy(tsOnly.graph, TS_PATHS), files: [] },
					{ ...ownedBy(mixed.graph, TS_PATHS), files: [] },
				),
				"TypeScript facts with and without PHP present",
			);
		},
		MATRIX_TEST_TIMEOUT_MS,
	);

	test(
		"re-enabling PHP reconstructs the clean mixed graph",
		async () => {
			const clean = await runCleanPipeline(MIXED_ENRICHED_MANIFEST);

			await withPipeline(MIXED_ENRICHED_MANIFEST, async (session) => {
				await session.indexAll();
				await session.reopen({
					modes: { typescript: "enriched", php: "disabled" },
				});
				await session.indexAll();
				await session.reopen({
					modes: { typescript: "enriched", php: "enriched" },
				});
				await session.indexAll();

				// Convergence, not merely "PHP came back": a leftover retirement record
				// or a stale error on a re-indexed file would show up here.
				const restored = await session.snapshot(
					MIXED_ENRICHED_MANIFEST.probes ?? [],
				);
				assertNoDiscrepancies(
					compareGraphs(restored.graph, clean.graph),
					"re-enabled PHP vs clean mixed index",
				);
				expect(restored.envelopes).toEqual(clean.envelopes);
			});
		},
		MATRIX_TEST_TIMEOUT_MS,
	);

	test(
		"query completeness follows the disabled backend honestly",
		async () => {
			await withPipeline(MIXED_ENRICHED_MANIFEST, async (session) => {
				await session.indexAll();
				await session.reopen({
					modes: { typescript: "enriched", php: "disabled" },
				});
				await session.indexAll();

				// A reverse question now reports itself incomplete, because the PHP
				// paths remain in the coverage figures as unindexed. Before the
				// scanner covered a disabled backend's extensions this answered
				// `partial: false` over a project half of which was missing.
				const callers = await session.astrograph.callers({ symbol: "process" });
				expect(callers.meta.partial).toBe(true);
				expect(callers.meta.coverage.total).toBe(
					TS_PATHS.length + PHP_PATHS.length,
				);
				expect(callers.meta.coverage.resolved).toBe(TS_PATHS.length);

				// The reason is currently a coverage gap rather than a capability
				// limit. That is imprecise — the honest reason is "the PHP backend is
				// switched off", not "these files are still being indexed" — and it
				// is recorded as a residual finding in the 0.1-C review rather than
				// papered over here.
				expect(
					(callers.meta.reasons ?? []).map((reason) => reason.kind),
				).toContain("coverage_incomplete");

				// The PHP declarations are gone from results rather than lingering.
				const search = await session.astrograph.search({ query: "process" });
				expect(
					search.data.every((entry) => entry.node.language !== "php"),
				).toBe(true);
			});
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("capabilities follow ownership in mixed configurations", () => {
	test(
		"PHP Pass-A-only leaves TypeScript relations intact",
		async () => {
			const { graph } = await runCleanPipeline(MIXED_PHP_PASS_A_MANIFEST);

			// PHP contributes containment only …
			const php = ownedBy(graph, PHP_PATHS);
			expect(new Set(php.edges.map((edge) => edge.kind))).toEqual(
				new Set(["contains"]),
			);

			// … and TypeScript still proves its own calls. A capability reduction in
			// one backend must not degrade the other.
			const ts = ownedBy(graph, TS_PATHS);
			expect(
				ts.edges.some(
					(edge) =>
						edge.kind === "calls" && edge.resolutionState === "resolved",
				),
			).toBe(true);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"the mirror configuration reports the mirror capability",
		async () => {
			const { graph } = await runCleanPipeline(MIXED_TS_PASS_A_MANIFEST);

			const ts = ownedBy(graph, TS_PATHS);
			expect(new Set(ts.edges.map((edge) => edge.kind))).toEqual(
				new Set(["contains"]),
			);

			const php = ownedBy(graph, PHP_PATHS);
			expect(
				php.edges.some(
					(edge) =>
						edge.kind === "calls" && edge.resolutionState === "resolved",
				),
			).toBe(true);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a global question is partial while any backend cannot prove it",
		async () => {
			await withPipeline(MIXED_PHP_PASS_A_MANIFEST, async (session) => {
				await session.indexAll();

				// `callers` is answerable only if *every* backend that owns files can
				// produce `calls`. PHP cannot, so the answer is partial with a
				// capability reason — even though the TypeScript half is complete.
				const callers = await session.astrograph.callers({ symbol: "process" });
				expect(callers.meta.partial).toBe(true);
				expect(
					(callers.meta.reasons ?? []).map((reason) => reason.kind),
				).toContain("capability_unsupported");

				// A question scoped to a TypeScript source stays complete: its domain
				// does not include the PHP half.
				const callees = await session.astrograph.callees({ symbol: "invoke" });
				expect(callees.meta.domain).toBe("local_outgoing");
			});
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});
