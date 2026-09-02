import { describe, expect, test } from "bun:test";
import { assertNoDiscrepancies, expectSnapshotsAgree } from "./assert";
import { compareGraphs, compareSnapshots } from "./compare";
import { registryWithThrowingParser } from "./failure-injection";
import { PipelineSession, runCleanPipeline, withPipeline } from "./harness";
import { ROUTE_SCRIPTS } from "./route-scripts";
import {
	eventsFor,
	finalManifest,
	type MutationScript,
	ROUTE_NAMES,
	runRoute,
} from "./routes";

/**
 * AG-307: clean full, reused full, scanner sync and event sync are one model.
 *
 * This is the correctness shield the 0.1-D performance work has to survive. Its
 * value depends entirely on not being weakened: no route-specific
 * normalization, no comparison by row count, and no expected graph authored per
 * route. Each row below compares three routes against a clean index of the same
 * final state, through the same oracle, and reports the differing table, file
 * and field when they disagree.
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

describe("four-route convergence", () => {
	for (const script of ROUTE_SCRIPTS) {
		test(
			`${script.id}: every route reaches the same graph`,
			async () => {
				const reference = await runRoute(script, "clean-full");

				for (const route of ROUTE_NAMES) {
					if (route === "clean-full") continue;
					const actual = await runRoute(script, route);
					expectSnapshotsAgree(
						actual,
						reference,
						`${script.id} via ${route} vs clean-full`,
					);
				}
			},
			MATRIX_TEST_TIMEOUT_MS,
		);
	}
});

describe("the matrix itself is not vacuous", () => {
	test(
		"every row moves a project that has a cross-file relation",
		async () => {
			// A guard on the guard, in two parts. If a row's fixture stopped producing
			// relations — a typo in a path, a mode that turns the enricher off by
			// accident — the four routes would still agree and the row would prove
			// nothing about retirement or re-resolution. And if a row's mutation
			// changed nothing at all, convergence would be trivially true.
			//
			// The relation is required at *one* of the two endpoints, not both: a
			// deletion row ends with it deliberately demoted, and an
			// oversized-to-eligible row begins with the file unparsed. Demanding it at
			// both ends would forbid exactly the mutations that matter most.
			for (const script of ROUTE_SCRIPTS) {
				const initial = await runCleanPipeline({
					id: `${script.id}/initial`,
					description: script.description,
					files: script.files,
					modes: script.modes,
					...(script.config === undefined ? {} : { config: script.config }),
				});
				const final = await runRoute(script, "clean-full");

				// The row does something.
				expect(
					compareGraphs(final.graph, initial.graph).length,
				).toBeGreaterThan(0);

				// Pass-A-only and disabled backends are the exception to the relation
				// requirement: containment is per file by definition, and such a
				// row's obligation is convergence, not richness.
				//
				// The exception is gated per backend, not per row. An OR over both
				// languages would waive the requirement for a mixed row's *enriched*
				// half too, so a misconfigured row could stop producing relations
				// entirely and still slip through.
				const provesRelations = (language: "typescript" | "php"): boolean =>
					script.modes[language] === "enriched";
				if (!provesRelations("typescript") && !provesRelations("php")) {
					expect(initial.graph.nodes.length).toBeGreaterThan(0);
					continue;
				}

				const crossFileCount = (snapshot: typeof initial): number => {
					const fileOf = new Map(
						snapshot.graph.nodes.map((node) => [node.id, node.filePath]),
					);
					return snapshot.graph.edges.filter(
						(edge) =>
							edge.target !== null &&
							edge.target !== undefined &&
							edge.resolutionState === "resolved" &&
							fileOf.get(edge.source) !== fileOf.get(edge.target),
					).length;
				};
				expect(crossFileCount(initial) + crossFileCount(final)).toBeGreaterThan(
					0,
				);
			}
		},
		MATRIX_TEST_TIMEOUT_MS,
	);

	test(
		"a probe that refuses is recorded as a refusal, not skipped",
		async () => {
			// `php-delete` removes the class that declares `run`, so `callers:run` has
			// no symbol to resolve and the tool throws `NOT_FOUND`. That is an
			// outcome, and every route has to reach the same one: silently dropping
			// the probe would make the four routes agree about a question none of
			// them answered.
			const script = ROUTE_SCRIPTS.find(
				(candidate) => candidate.id === "php-delete",
			) as MutationScript | undefined;
			expect(script).toBeDefined();
			if (script === undefined) return;

			const { envelopes } = await runRoute(script, "clean-full");
			expect(envelopes["callers:run"]).toEqual({ errorCode: "NOT_FOUND" });
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a deliberate divergence is caught and attributed",
		async () => {
			// The oracle must fail on a one-field difference in one row of one table.
			// This is the same tamper the AG-302 smoke test applies, run here against
			// a route comparison so the AG-307 failure path is exercised too.
			const script = ROUTE_SCRIPTS[0];
			expect(script).toBeDefined();
			if (script === undefined) return;

			const reference = await runRoute(script, "clean-full");
			const tampered = structuredClone(reference);
			const edge = tampered.graph.edges.find(
				(candidate) => candidate.resolutionState === "resolved",
			);
			expect(edge).toBeDefined();
			if (edge !== undefined) edge.resolutionState = "unresolved";

			const discrepancies = compareSnapshots(reference, tampered);
			expect(discrepancies.length).toBe(1);
			expect(discrepancies[0]?.scope).toBe("edges");
			expect(() =>
				assertNoDiscrepancies(discrepancies, "tampered reference"),
			).toThrow("edges");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("event batches stay honest", () => {
	test(
		"a batch derived from the script names only what changed",
		() => {
			// The event route's whole value is that it may not look at anything the
			// watcher did not report. A derived batch that quietly included every
			// path would make the route a second `sync()`.
			const modify = ROUTE_SCRIPTS.find(
				(script) => script.id === "jsts-modify",
			) as MutationScript | undefined;
			expect(modify).toBeDefined();
			if (modify === undefined) return;

			expect(eventsFor(modify)).toEqual([
				{ type: "change", path: "src/target.ts" },
			]);

			const rename = ROUTE_SCRIPTS.find(
				(script) => script.id === "jsts-rename",
			) as MutationScript | undefined;
			expect(rename).toBeDefined();
			if (rename === undefined) return;

			// A rename is not an event type. It is an unlink and an add, plus the
			// change to whoever imported it.
			expect(eventsFor(rename)).toEqual([
				{ type: "change", path: "src/caller.ts" },
				{ type: "add", path: "src/renamed.ts" },
				{ type: "unlink", path: "src/target.ts" },
			]);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a configuration-only row derives an empty batch and still converges",
		async () => {
			// This is the one case where the batch legitimately says nothing: nothing
			// on disk moved. `syncFiles` sees the configuration identity change and
			// reconsiders the whole membership, which is why the row converges without
			// the batch naming a single path.
			const script = ROUTE_SCRIPTS.find(
				(candidate) => candidate.id === "jsts-exclude-added",
			) as MutationScript | undefined;
			expect(script).toBeDefined();
			if (script === undefined) return;

			expect(eventsFor(script)).toEqual([]);
			expectSnapshotsAgree(
				await runRoute(script, "event-sync"),
				await runRoute(script, "clean-full"),
				"configuration-only row via event-sync",
			);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"an unmentioned file is left alone by an event batch",
		async () => {
			const script = ROUTE_SCRIPTS.find(
				(candidate) => candidate.id === "jsts-modify",
			) as MutationScript | undefined;
			expect(script).toBeDefined();
			if (script === undefined) return;

			await withPipeline(
				{
					id: "jsts-modify/silence",
					description: script.description,
					files: script.files,
					modes: script.modes,
				},
				async (session) => {
					await session.indexAll();

					// Both files change on disk; the batch mentions one. The other must
					// keep its previous rows: treating silence as deletion would empty
					// the graph on the first single-file save.
					await session.mutate([
						{ write: "src/target.ts", content: "export const gone = 1;\n" },
						{ write: "src/caller.ts", content: "export const alsoGone = 1;\n" },
					]);
					const result = await session.syncFiles([
						{ type: "change", path: "src/target.ts" },
					]);

					expect(result.modified).toEqual(["src/target.ts"]);
					expect(result.removed).toEqual([]);
					const graph = session.snapshotGraph();
					expect(graph.nodes.some((node) => node.name === "caller")).toBe(true);
				},
			);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("an interrupted pass recovers to the same graph", () => {
	test(
		"a crashed index followed by a clean one converges",
		async () => {
			const manifest = finalManifest(
				ROUTE_SCRIPTS[0] ?? {
					id: "empty",
					description: "",
					files: {},
					modes: {},
				},
			);
			const reference = await runCleanPipeline({
				...manifest,
				id: "recovery/reference",
			});

			const session = await PipelineSession.open({
				...manifest,
				id: "recovery/interrupted",
				injection: {
					createRegistry: registryWithThrowingParser("typescript", [
						"src/target.ts",
					]),
				},
			});
			try {
				// The pass aborts partway, so the database holds a mixture of one
				// generation's rows and none of the next.
				await expect(session.indexAll()).rejects.toThrow(
					"injected Pass A crash",
				);

				// Recovery is an ordinary open with a working backend. What it must not
				// do is trust the interrupted identity and skip unchanged files.
				await session.reopen({ injection: {} });
				await session.indexAll();

				assertNoDiscrepancies(
					compareGraphs(session.snapshotGraph(), reference.graph),
					"recovered index vs clean index",
				);
			} finally {
				await session.close();
			}
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});
