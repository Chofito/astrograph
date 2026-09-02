import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { assertGraphIntegrity } from "../../src/testing/graph-assertions";
import type { StorageAdapter } from "../../src/types";
import { expectMatchesGolden, expectSnapshotsAgree } from "./assert";
import { compareSnapshots, formatDiscrepancies } from "./compare";
import {
	PIPELINE_PINNED_NOW,
	PipelineSession,
	runCleanPipeline,
	withPipeline,
} from "./harness";
import { SMOKE_MANIFEST } from "./smoke-fixture";

/**
 * AG-302: the harness itself is under test here.
 *
 * Nothing in this file is a claim about JS/TS or PHP semantics — those are
 * AG-303 and AG-304. What it has to establish is that the harness reaches the
 * production composition, that its output does not depend on where it ran or
 * when, that a divergence from a reviewed expectation *fails*, and that a
 * session releases its database and its temporary tree on both the success and
 * the initialization-failure path.
 */

/**
 * Every test in this file runs real indexing — a TypeScript program, tree-sitter
 * parses and a SQLite database per pipeline — so the explicit timeouts below are
 * headroom for a loaded machine, not permission to be slow. Bun's 5 s default
 * left the four-route rows failing on contention alone while they were doing
 * about two seconds of genuine work.
 */
const PIPELINE_TEST_TIMEOUT_MS = 60_000;

describe("the production-pipeline harness reaches the real composition", () => {
	test(
		"registry, Indexer, SQLite and GraphQueries all participate",
		async () => {
			await withPipeline(SMOKE_MANIFEST, async (session) => {
				await session.indexAll();

				// SQLite: the rows are read back out of the database, not out of an
				// extractor's return value.
				const graph = session.snapshotGraph();
				assertGraphIntegrity({ nodes: graph.nodes, edges: graph.edges });
				expect(graph.files.map((file) => file.path)).toEqual([
					"src/caller.ts",
					"src/target.ts",
				]);

				// The registry routed both files to the TypeScript backend.
				expect(new Set(graph.files.map((file) => file.language))).toEqual(
					new Set(["typescript"]),
				);

				// The enricher resolved across files through persisted Pass A rows,
				// which is only possible if the Indexer ran both phases in order.
				const call = graph.edges.find(
					(edge) => edge.kind === "calls" && edge.targetName === "target",
				);
				expect(call?.resolutionState).toBe("resolved");
				expect(call?.target).not.toBeNull();

				// GraphQueries: a real tool answer, with its trust envelope.
				const callers = await session.astrograph.callers({ symbol: "target" });
				expect(callers.data.map((entry) => entry.caller.name)).toEqual([
					"caller",
				]);
				expect(callers.meta.coverage.total).toBe(2);
			});
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"the recorded golden still describes the shipped pipeline",
		async () => {
			await expectMatchesGolden(
				SMOKE_MANIFEST.id,
				await runCleanPipeline(SMOKE_MANIFEST),
			);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("the harness is deterministic", () => {
	test(
		"two runs under different temporary roots agree",
		async () => {
			// Different `mkdtemp` directories, different SQLite files, same clock.
			// A path or an absolute-path-bearing diagnostic that survived
			// normalization would fail here.
			const first = await runCleanPipeline(SMOKE_MANIFEST);
			const second = await runCleanPipeline(SMOKE_MANIFEST);
			expectSnapshotsAgree(second, first, "second run vs first run");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"the clock is pinned, so nothing in the snapshot moves with time",
		async () => {
			await withPipeline(SMOKE_MANIFEST, async (session) => {
				await session.indexAll();
				const stats = await session.astrograph.getStats({});
				expect(stats.data.lastUpdated).toBe(PIPELINE_PINNED_NOW);
			});
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("the harness fails when persisted truth differs from its expectation", () => {
	test(
		"a single changed resolution state is reported, attributed and fatal",
		async () => {
			const snapshot = await runCleanPipeline(SMOKE_MANIFEST);

			// The reviewed expectation, with one edge demoted. This is the shape of
			// the regression the oracle exists to catch: same rows, same counts, one
			// relation that stopped being proven.
			const tampered = structuredClone(snapshot);
			const call = tampered.graph.edges.find(
				(edge) => edge.kind === "calls" && edge.targetName === "target",
			);
			expect(call).toBeDefined();
			if (call !== undefined) {
				call.resolutionState = "unresolved";
				call.confidence = "low";
			}

			const discrepancies = compareSnapshots(snapshot, tampered);
			expect(discrepancies.length).toBe(1);
			expect(discrepancies[0]?.scope).toBe("edges");
			expect(discrepancies[0]?.kind).toBe("changed");
			expect(
				(discrepancies[0]?.fields ?? []).map((field) => field.field),
			).toEqual(["confidence", "resolutionState"]);
			// Attributed to whatever produced the relation, so a mixed-language
			// failure names its backend (AG-305).
			expect(discrepancies[0]?.attribution).toBe(call?.provenance);
			expect(formatDiscrepancies(discrepancies)).toContain("resolutionState");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a dropped node and a dropped file are both reported",
		async () => {
			const snapshot = await runCleanPipeline(SMOKE_MANIFEST);
			const tampered = structuredClone(snapshot);
			tampered.graph.nodes = tampered.graph.nodes.filter(
				(node) => node.filePath !== "src/target.ts",
			);
			tampered.graph.files = tampered.graph.files.filter(
				(file) => file.path !== "src/target.ts",
			);

			// Every row the expectation no longer contains is `unexpected` in the
			// actual snapshot; none of them is silently tolerated.
			const discrepancies = compareSnapshots(snapshot, tampered);
			expect(discrepancies.length).toBeGreaterThan(1);
			expect(new Set(discrepancies.map((entry) => entry.scope))).toEqual(
				new Set(["files", "nodes"]),
			);
			expect(discrepancies.every((entry) => entry.kind === "unexpected")).toBe(
				true,
			);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"an envelope difference fails without touching the graph",
		async () => {
			const snapshot = await runCleanPipeline(SMOKE_MANIFEST);
			const tampered = structuredClone(snapshot);
			const probe = "callers:target";
			const envelope = tampered.envelopes[probe];
			expect(envelope).toBeDefined();
			if (envelope !== undefined) envelope.partial = !envelope.partial;

			const discrepancies = compareSnapshots(snapshot, tampered);
			expect(discrepancies).toEqual([
				{
					scope: "envelopes",
					kind: "changed",
					key: probe,
					fields: [
						{
							field: "envelope",
							actual: expect.any(String),
							expected: expect.any(String),
						},
					],
				},
			]);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a missing golden names the command that records it",
		async () => {
			await expect(
				expectMatchesGolden(
					"no-such-fixture",
					await runCleanPipeline(SMOKE_MANIFEST),
				),
			).rejects.toThrow("update-goldens.ts no-such-fixture");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("a session owns its resources", () => {
	test(
		"close releases the temporary root",
		async () => {
			const session = await PipelineSession.open(SMOKE_MANIFEST);
			const root = session.root;
			await session.indexAll();
			expect(existsSync(root)).toBe(true);

			await session.close();
			expect(existsSync(root)).toBe(false);
			// Idempotent: a `finally` that closes twice must not throw.
			await session.close();
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a body that throws still releases the root",
		async () => {
			let root = "";
			await expect(
				withPipeline(SMOKE_MANIFEST, async (session) => {
					root = session.root;
					throw new Error("fixture body failed");
				}),
			).rejects.toThrow("fixture body failed");
			expect(root.length).toBeGreaterThan(0);
			expect(existsSync(root)).toBe(false);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a failed initialization releases the root and the storage handle",
		async () => {
			// `openProject` closes the handle it opened when a later composition step
			// throws (AG-209); the harness has to do the same for the directory it
			// created, or a failing fixture leaks a temp tree per run.
			let observedPath = "";
			let grammarLoads = 0;

			await expect(
				PipelineSession.open({
					...SMOKE_MANIFEST,
					id: "smoke-initialization-failure",
					injection: {
						createStorage: (path): StorageAdapter => {
							observedPath = path;
							throw new Error("storage refused to open");
						},
						async loadGrammars() {
							grammarLoads += 1;
						},
					},
				}),
			).rejects.toThrow("storage refused to open");

			expect(observedPath).toContain("astrograph-pipeline-");
			// Storage is opened first, so nothing downstream of it ran.
			expect(grammarLoads).toBe(0);
			const root = observedPath.slice(0, observedPath.indexOf("/.astrograph"));
			expect(existsSync(root)).toBe(false);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});
