import { describe, expect, test } from "bun:test";
import { assertGraphIntegrity } from "../../src/testing/graph-assertions";
import { expectMatchesGolden } from "./assert";
import { runCleanPipeline, withPipeline } from "./harness";
import {
	JSTS_ENRICHED_MANIFEST,
	JSTS_EXTERNAL_PACKAGE_MANIFEST,
	JSTS_MANIFESTS,
	JSTS_PASS_A_MANIFEST,
} from "./jsts-fixtures";

/**
 * AG-303: the shipped JS/TS backend, proven through the production pipeline.
 *
 * The goldens carry the detail. The tests below assert the *invariants* a
 * reviewer would otherwise have to re-derive from a thousand lines of JSON:
 * which backend owned which file, that resolution really crossed files, that
 * Pass-A-only claims nothing it cannot prove, and that the two modes agree on
 * node identity wherever they overlap.
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

describe("JS/TS production goldens", () => {
	for (const manifest of JSTS_MANIFESTS) {
		test(
			`${manifest.id} matches its reviewed golden`,
			async () => {
				const snapshot = await runCleanPipeline(manifest);
				assertGraphIntegrity({
					nodes: snapshot.graph.nodes,
					edges: snapshot.graph.edges,
				});
				await expectMatchesGolden(manifest.id, snapshot);
			},
			PIPELINE_TEST_TIMEOUT_MS,
		);
	}
});

describe("registry selection and persistence", () => {
	test(
		"one backend owns every source, whatever its extension",
		async () => {
			const { graph } = await runCleanPipeline(JSTS_ENRICHED_MANIFEST);

			expect(graph.files.map((file) => file.path)).toEqual([
				"src/app.ts",
				"src/core/compute.ts",
				"src/core/index.ts",
				"src/legacy.js",
				"src/merged.ts",
				"src/unprovable.ts",
				"src/widget.tsx",
			]);

			// The language recorded per file is the registry's routing decision, made
			// from the extension alone. `.tsx` and `.js` are the two that a
			// single-language assumption would get wrong.
			expect(
				Object.fromEntries(
					graph.files.map((file) => [file.path, file.language]),
				),
			).toEqual({
				"src/app.ts": "typescript",
				"src/core/compute.ts": "typescript",
				"src/core/index.ts": "typescript",
				"src/legacy.js": "javascript",
				"src/merged.ts": "typescript",
				"src/unprovable.ts": "typescript",
				"src/widget.tsx": "tsx",
			});

			// Every file reached the end of the pipeline: `resolved` is the state the
			// enricher's edge phase writes, so a file stuck at `parsed` would mean
			// Pass B never ran for it.
			expect(new Set(graph.files.map((file) => file.state))).toEqual(
				new Set(["resolved"]),
			);
			expect(graph.files.flatMap((file) => file.errors)).toEqual([]);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"resolution crosses files, including through a barrel",
		async () => {
			const { graph } = await runCleanPipeline(JSTS_ENRICHED_MANIFEST);
			const compute = graph.nodes.find(
				(node) =>
					node.name === "compute" && node.filePath === "src/core/compute.ts",
			);
			expect(compute).toBeDefined();

			// Callers reach `compute` from four files, one of which is JavaScript and
			// one of which only sees it through `src/core/index.ts`.
			const callers = graph.edges
				.filter(
					(edge) =>
						edge.kind === "calls" &&
						edge.target === compute?.id &&
						edge.resolutionState === "resolved",
				)
				.map((edge) => edge.source);
			const callerFiles = new Set(
				callers.map(
					(id) => graph.nodes.find((node) => node.id === id)?.filePath ?? "?",
				),
			);
			expect(callerFiles).toEqual(
				new Set([
					"src/app.ts",
					"src/core/compute.ts",
					"src/legacy.js",
					"src/widget.tsx",
				]),
			);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"an unprovable target stays unresolved, with no target at all",
		async () => {
			const { graph } = await runCleanPipeline(JSTS_ENRICHED_MANIFEST);

			// `unresolved` is the weakest claim the graph can make: the relation was
			// written, and nothing proves what it points at. The assertion is on the
			// exact state, not on `!== "resolved"` — that accepted `external` too,
			// and `external` is a materially stronger claim ("the declaration is
			// known, it is simply not yours"). Conflating them is how the fixture
			// used to pass while the harness was silently resolving `node:path`
			// through this repository's own installed types.
			const unprovable = graph.edges.filter(
				(edge) =>
					edge.targetName === "node:path" ||
					edge.targetName === "join" ||
					edge.targetName === "target.whatever" ||
					edge.targetName === "import",
			);
			expect(unprovable.length).toBe(4);
			expect(new Set(unprovable.map((edge) => edge.resolutionState))).toEqual(
				new Set(["unresolved"]),
			);
			expect(unprovable.every((edge) => edge.target === null)).toBe(true);
			expect(new Set(unprovable.map((edge) => edge.confidence))).toEqual(
				new Set(["low"]),
			);
			// The text the source wrote survives, or the relation would be evidence
			// of nothing.
			expect(
				unprovable.every((edge) => (edge.targetName ?? "").length > 0),
			).toBe(true);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"an ambiguous reference keeps a target and names its alternatives",
		async () => {
			const { graph } = await runCleanPipeline(JSTS_ENRICHED_MANIFEST);
			const merged = graph.nodes.filter(
				(node) => node.name === "merged" && node.filePath === "src/merged.ts",
			);
			expect(merged.length).toBe(2);

			// `ambiguous` is the fourth state and the only one that carries both a
			// target and the set it was chosen from. A regression that silently
			// picked one candidate would report `resolved` and lose the other, and
			// asserting only on the node count would not notice.
			const reference = graph.edges.find(
				(edge) => edge.kind === "references" && edge.targetName === "merged",
			);
			expect(reference?.resolutionState).toBe("ambiguous");
			expect(reference?.target).not.toBeNull();
			expect(new Set(reference?.metadata?.candidates as string[])).toEqual(
				new Set(merged.map((node) => node.id)),
			);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"the merged declaration is recorded, not silently collapsed",
		async () => {
			const { graph } = await runCleanPipeline(JSTS_ENRICHED_MANIFEST);
			const merged = graph.nodes.filter(
				(node) => node.name === "merged" && node.filePath === "src/merged.ts",
			);

			// A function and a namespace share one name. Both declarations exist and
			// their ids differ, which is what keeps `readTag`'s reference honest
			// instead of arbitrarily attributing it to one of them.
			expect(merged.length).toBe(2);
			expect(new Set(merged.map((node) => node.id)).size).toBe(merged.length);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("an installed dependency becomes an external node", () => {
	test(
		"the external declaration is persisted, root-relative and outside the project",
		async () => {
			const { graph } = await runCleanPipeline(JSTS_EXTERNAL_PACKAGE_MANIFEST);

			// The package is never indexed as project content: `node_modules/` is
			// hard-excluded from the scan, so exactly one file is owned.
			expect(graph.files.map((file) => file.path)).toEqual(["src/app.ts"]);

			const external = graph.nodes.filter((node) => node.isExternal);
			expect(external.map((node) => node.name)).toEqual(["tinyHelper"]);
			// Root-relative, so the node id is the same on every machine. An
			// absolute path here would mean the golden encoded a checkout location.
			expect(external[0]?.filePath).toBe("node_modules/tiny-lib/index.d.ts");
			expect(external[0]?.filePath.startsWith("/")).toBe(false);

			// `external` is the resolution state, and it carries a target: the
			// declaration is known, it just is not ours. That is a different claim
			// from `unresolved`, which is what `node:path` gets in the fixture above.
			const call = graph.edges.find(
				(edge) => edge.kind === "calls" && edge.targetName === "tinyHelper",
			);
			expect(call?.resolutionState).toBe("external");
			expect(call?.target).toBe(external[0]?.id ?? "");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("Pass-A-only stays useful and honest", () => {
	test(
		"it claims no enricher-only edge kind",
		async () => {
			const { graph } = await runCleanPipeline(JSTS_PASS_A_MANIFEST);

			// `contains` is the only kind Pass A can prove. A `calls` edge here would
			// mean the enricher ran despite being configured off.
			expect(new Set(graph.edges.map((edge) => edge.kind))).toEqual(
				new Set(["contains"]),
			);
			expect(graph.nodes.length).toBeGreaterThan(0);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a reverse question says why it cannot answer",
		async () => {
			await withPipeline(JSTS_PASS_A_MANIFEST, async (session) => {
				await session.indexAll();
				const callers = await session.astrograph.callers({ symbol: "compute" });

				// The failure mode this rules out: an empty list under `partial: false`,
				// which reads as "nothing calls compute".
				expect(callers.data).toEqual([]);
				expect(callers.meta.partial).toBe(true);
				expect(
					(callers.meta.reasons ?? []).map((reason) => reason.kind),
				).toContain("capability_unsupported");
			});
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a structural question is still answered completely",
		async () => {
			await withPipeline(JSTS_PASS_A_MANIFEST, async (session) => {
				await session.indexAll();

				// Pass-A-only is a reduced index, not a broken one: discovery over
				// declarations works, and nothing about it is partial.
				const search = await session.astrograph.search({ query: "compute" });
				expect(search.data.length).toBeGreaterThan(0);
				expect(search.meta.partial).toBe(false);
			});
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"Pass A node ids are a subset of the enriched ones",
		async () => {
			// The subset contract, observed where it actually matters: through
			// persistence. If Pass A minted an id the enricher would not, turning the
			// enricher on would churn every id in the database.
			const [passA, enriched] = await Promise.all([
				runCleanPipeline(JSTS_PASS_A_MANIFEST),
				runCleanPipeline(JSTS_ENRICHED_MANIFEST),
			]);

			// Without this guard the orphan check below is vacuous: an empty Pass A
			// node set has no orphans either.
			expect(passA.graph.nodes.length).toBeGreaterThan(0);
			expect(enriched.graph.nodes.length).toBeGreaterThan(
				passA.graph.nodes.length,
			);

			const enrichedIds = new Set(enriched.graph.nodes.map((node) => node.id));
			const orphans = passA.graph.nodes
				.map((node) => node.id)
				.filter((id) => !enrichedIds.has(id));
			expect(orphans).toEqual([]);
		},
		MATRIX_TEST_TIMEOUT_MS,
	);
});
