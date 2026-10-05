import { describe, expect, test } from "bun:test";
import {
	assertGraphIntegrity,
	assertNoDanglingResolved,
	edgeDedupKey,
} from "../../src/testing/graph-assertions";
import type { NormalizedIndex } from "../../src/testing/normalize";
import { expectMatchesGolden } from "./assert";
import { runCleanPipeline, withPipeline } from "./harness";
import { phpCallsManifest, phpManifests } from "./php-fixtures";

/**
 * AG-304: the shipped PHP backend, proven through the production pipeline.
 *
 * PHP resolution is receiver-aware and entirely tree-sitter based: there is no
 * compiler to fall back on, so every resolved edge has to be justified by a
 * receiver the backend could actually prove. The tests below pin the boundary
 * from both sides — what must resolve, and what must *stay* unresolved — because
 * a name-only fallback would make this fixture greener and the product wrong.
 */

/**
 * Every test in this file runs real indexing — a TypeScript program, tree-sitter
 * parses and a SQLite database per pipeline — so the explicit timeouts below are
 * headroom for a loaded machine, not permission to be slow. Bun's 5 s default
 * left the four-route rows failing on contention alone while they were doing
 * about two seconds of genuine work.
 */
const PIPELINE_TEST_TIMEOUT_MS = 60_000;

const MANIFESTS = await phpManifests();
const ENRICHED_CALLS = await phpCallsManifest("enriched");
const PASS_A_CALLS = await phpCallsManifest("pass-a-only");

/** Every `calls` edge leaving the methods of one class. */
function callsFrom(
	graph: NormalizedIndex,
	className: string,
	methodName: string,
) {
	const method = graph.nodes.find(
		(node) =>
			node.name === methodName &&
			node.qualifiedName.includes(className) &&
			(node.kind === "method" || node.kind === "function"),
	);
	return graph.edges.filter(
		(edge) => edge.kind === "calls" && edge.source === method?.id,
	);
}

describe("PHP production goldens", () => {
	for (const manifest of MANIFESTS) {
		test(
			`${manifest.id} matches its reviewed golden`,
			async () => {
				const snapshot = await runCleanPipeline(manifest);
				if (manifest.id === "php-grouped-use-mixed") {
					// DEV-010 emits two external `imports` from one mixed grouped
					// `use` — `Vendor\\baz` and `Vendor\\QUX` — that share the
					// TypeScript resolver dedup key (source, kind, null target,
					// line). Persistence keeps both rows; treating that collision
					// as integrity failure would reject the pin. Resolved targets
					// must still exist.
					assertNoDanglingResolved(
						snapshot.graph.edges,
						snapshot.graph.nodes,
					);
				} else {
					assertGraphIntegrity({
						nodes: snapshot.graph.nodes,
						edges: snapshot.graph.edges,
					});
				}
				await expectMatchesGolden(manifest.id, snapshot);
			},
			PIPELINE_TEST_TIMEOUT_MS,
		);
	}
});

describe("receiver-aware resolution stays inside STEP 3", () => {
	test(
		"every resolved call points at an indexed method",
		async () => {
			const { graph } = await runCleanPipeline(ENRICHED_CALLS);
			const methodIds = new Set(
				graph.nodes
					.filter((node) => node.kind === "method" || node.kind === "function")
					.map((node) => node.id),
			);

			expect(methodIds.size).toBeGreaterThan(0);
			const resolved = graph.edges.filter(
				(edge) => edge.kind === "calls" && edge.resolutionState === "resolved",
			);
			expect(resolved.length).toBeGreaterThan(0);
			expect(
				resolved.filter((edge) => !methodIds.has(edge.target ?? "")),
			).toEqual([]);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"the promised receiver buckets resolve",
		async () => {
			const { graph } = await runCleanPipeline(ENRICHED_CALLS);
			const calls = callsFrom(graph, "Worker", "bucketOne");

			// Promoted constructor property, typed property and constructor-assigned
			// property are THREE separate buckets that all call `run()`. Keying a
			// Map by `targetName` collapsed them onto one entry, so the test
			// verified whichever edge happened to come last and would have passed
			// with two of the three buckets broken.
			const runCalls = calls.filter((edge) => edge.targetName === "run");
			expect(runCalls.length).toBe(3);
			expect(
				runCalls.every((edge) => edge.resolutionState === "resolved"),
			).toBe(true);
			// All three receivers are typed `Dep`, so all three must land on the
			// same method — one target, not three guesses.
			expect(new Set(runCalls.map((edge) => edge.target)).size).toBe(1);
			expect(runCalls[0]?.target).not.toBeNull();

			// The interface-typed property and the static `self::` call, each once.
			for (const target of ["ping", "staticOk"]) {
				const matches = calls.filter((edge) => edge.targetName === target);
				expect(matches.length).toBe(1);
				expect(matches[0]?.resolutionState).toBe("resolved");
				expect(matches[0]?.target).not.toBeNull();
			}

			// `new Dep()` is an instantiation, not a call, and resolves to the class.
			const instantiates = graph.edges.filter(
				(edge) => edge.kind === "instantiates" && edge.targetName === "Dep",
			);
			expect(instantiates.length).toBeGreaterThan(0);
			expect(
				instantiates.every((edge) => edge.resolutionState === "resolved"),
			).toBe(true);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"inherited methods resolve through the parent chain",
		async () => {
			const { graph } = await runCleanPipeline(ENRICHED_CALLS);
			const calls = callsFrom(graph, "Child", "go");

			// `parent::inherited()` and `$this->inherited()` both name a method
			// declared one class up; both must land on it.
			expect(calls.length).toBe(2);
			expect(calls.every((edge) => edge.resolutionState === "resolved")).toBe(
				true,
			);
			expect(new Set(calls.map((edge) => edge.targetName))).toEqual(
				new Set(["inherited"]),
			);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"display casing is preserved, and DEV-009 is pinned as still open",
		async () => {
			const { graph } = await runCleanPipeline(ENRICHED_CALLS);

			// Half of the AG-304 casing row holds today: the declaration keeps the
			// casing it was written with, and the differently-cased reference does not
			// mint a second class.
			const declared = graph.nodes.filter((node) => node.kind === "class");
			expect(declared.some((node) => node.name === "MixedCase")).toBe(true);
			expect(declared.some((node) => node.name === "MIXEDCASE")).toBe(false);
			expect(
				graph.nodes.find((node) => node.name === "doWork")?.qualifiedName,
			).toContain("MixedCase");

			// The other half does not. `private readonly MIXEDCASE $service` names an
			// in-project class in a different case, and PHP class names are
			// case-insensitive, so `$this->service->doWork()` is a real in-project
			// relation. The shipped lookup keys are case-sensitive (DEV-009, open), so
			// the receiver type is classified as *outside* the project instead.
			//
			// This assertion is deliberately the current behaviour, not the intended
			// one: it is the AS-IS evidence DEV-009 was missing. The day canonical
			// lookup keys land, this test and the recorded golden both fail and have
			// to be re-reviewed. Nothing here endorses the outcome.
			const call = callsFrom(graph, "CasingConsumer", "go").find(
				(edge) => edge.targetName?.endsWith("doWork") === true,
			);
			expect(call?.resolutionState).toBe("external");
			expect(call?.target).toBeNull();
			expect(call?.targetName).toContain("MIXEDCASE");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"DEV-010 mixed grouped-use contaminates the type alias map",
		async () => {
			const manifest = MANIFESTS.find(
				(candidate) => candidate.id === "php-grouped-use-mixed",
			);
			expect(manifest).toBeDefined();
			if (manifest === undefined) return;

			const { graph } = await runCleanPipeline(manifest);

			// Correct PHP: `use Vendor\{Bar, function baz, const QUX}` imports
			// only `Bar` as a class. `baz` is a function and `QUX` is a constant;
			// neither belongs in class or type resolution.
			//
			// Astrograph AS-IS (DEV-010, still open): `collectUseDeclaration`
			// copies every grouped clause into the type alias map, so `baz` and
			// `QUX` become class aliases for `Vendor\\baz` and `Vendor\\QUX`.
			// The assertions below are the current wrong behaviour, not the
			// intended one. Repairing DEV-010 must change this test and its
			// recorded golden; nothing here endorses the outcome.

			const barClass = graph.nodes.find(
				(node) => node.kind === "class" && node.name === "Bar",
			);
			expect(barClass).toBeDefined();

			const instantiatesBar = graph.edges.find(
				(edge) =>
					edge.kind === "instantiates" && edge.targetName === "Bar",
			);
			expect(instantiatesBar?.resolutionState).toBe("resolved");
			expect(instantiatesBar?.target).toBe(barClass?.id);

			// The defect: `new baz()` is treated as constructing a class named
			// through the contaminated alias, not as a function import. There is
			// no `Vendor\\baz` class on disk, so the edge is `external` rather
			// than absent. An assertion that only checked `Bar` would hide this.
			const instantiatesBaz = graph.edges.find(
				(edge) =>
					edge.kind === "instantiates" &&
					(edge.targetName === "baz" ||
						edge.targetName?.endsWith("\\baz") === true),
			);
			expect(instantiatesBaz).toBeDefined();
			expect(instantiatesBaz?.resolutionState).toBe("external");
			expect(instantiatesBaz?.target).toBeNull();

			const typeOfQux = graph.edges.find(
				(edge) =>
					edge.kind === "type_of" &&
					(edge.targetName === "QUX" ||
						edge.targetName?.endsWith("\\QUX") === true),
			);
			expect(typeOfQux).toBeDefined();
			expect(typeOfQux?.resolutionState).toBe("external");
			expect(typeOfQux?.target).toBeNull();

			const imported = graph.edges.filter((edge) => edge.kind === "imports");
			expect(
				imported.some(
					(edge) =>
						edge.resolutionState === "resolved" &&
						edge.target === barClass?.id,
				),
			).toBe(true);
			expect(
				imported.some(
					(edge) =>
						edge.resolutionState === "external" &&
						edge.target === null &&
						edge.targetName?.endsWith("\\baz") === true,
				),
			).toBe(true);
			expect(
				imported.some(
					(edge) =>
						edge.resolutionState === "external" &&
						edge.target === null &&
						edge.targetName?.endsWith("\\QUX") === true,
				),
			).toBe(true);

			// The two contaminating imports share the TypeScript resolver
			// dedup key. That is why this fixture cannot use
			// `assertUniqueEdgeKeys`: dropping either row would hide DEV-010.
			const contaminatingImports = imported.filter(
				(edge) =>
					edge.resolutionState === "external" &&
					edge.target === null &&
					(edge.targetName?.endsWith("\\baz") === true ||
						edge.targetName?.endsWith("\\QUX") === true),
			);
			expect(contaminatingImports.length).toBe(2);
			expect(new Set(contaminatingImports.map(edgeDedupKey)).size).toBe(1);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("what PHP must refuse to prove", () => {
	test(
		"a call on an untyped variable stays unresolved",
		async () => {
			const { graph } = await runCleanPipeline(ENRICHED_CALLS);
			const call = callsFrom(graph, "Dynamic", "wild").find(
				(edge) => edge.targetName === "foo",
			);

			// `$unknown->foo()` has no provable receiver. The relation is still
			// recorded — that is the evidence a user needs — but never resolved.
			expect(call?.resolutionState).toBe("unresolved");
			expect(call?.target).toBeNull();
			expect(call?.confidence).toBe("low");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a method that does not exist on the chain stays unresolved, with a diagnostic",
		async () => {
			const { graph } = await runCleanPipeline(ENRICHED_CALLS);
			const call = callsFrom(graph, "MissingCall", "nope").find(
				(edge) => edge.targetName?.endsWith("doesNotExist") === true,
			);
			expect(call?.resolutionState).toBe("unresolved");
			expect(call?.target).toBeNull();

			// Persisted evidence, attributable to the file that contains the call.
			const file = graph.files.find((entry) =>
				entry.path.endsWith("MissingCall.php"),
			);
			expect((file?.errors ?? []).map((error) => error.code)).toContain(
				"PHP_CALL_UNRESOLVED",
			);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a call on a vendor parent is external, not invented",
		async () => {
			const { graph } = await runCleanPipeline(ENRICHED_CALLS);
			const call = callsFrom(graph, "VendorLeaf", "loadRow").find(
				(edge) => edge.targetName?.includes("getData") === true,
			);

			// The parent class is not on disk, so the chain leaves the project. That
			// is a different answer from "unresolved": the receiver *is* known, its
			// declaration simply is not ours.
			expect(call?.resolutionState).toBe("external");
			expect(call?.target).toBeNull();
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"no resolved edge is justified by a bare method name",
		async () => {
			const { graph } = await runCleanPipeline(ENRICHED_CALLS);

			// Guard: the two unprovable calls must exist, or the filter below is
			// searching an empty set and proves nothing.
			const unprovable = graph.edges.filter(
				(edge) =>
					edge.kind === "calls" &&
					(edge.targetName?.endsWith("foo") === true ||
						edge.targetName?.endsWith("doesNotExist") === true),
			);
			expect(unprovable.length).toBe(2);

			// `run` is declared on `App\\Dep`. `Dynamic::wild` and `MissingCall::nope`
			// call methods by name with no provable receiver; if a name-only fallback
			// existed, one of them would have been promoted to a resolved target.
			const namesResolvedFromNowhere = graph.edges.filter(
				(edge) =>
					edge.kind === "calls" &&
					edge.resolutionState === "resolved" &&
					(edge.targetName?.endsWith("foo") === true ||
						edge.targetName?.endsWith("doesNotExist") === true),
			);
			expect(namesResolvedFromNowhere).toEqual([]);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("PHP heritage and type positions", () => {
	test(
		"grouped, aliased and absolute imports all resolve to their class",
		async () => {
			const manifest = MANIFESTS.find(
				(candidate) => candidate.id === "php-heritage-enriched",
			);
			expect(manifest).toBeDefined();
			if (manifest === undefined) return;

			const { graph } = await runCleanPipeline(manifest);
			const heritage = graph.edges.filter(
				(edge) => edge.kind === "extends" || edge.kind === "implements",
			);
			const resolvedNames = new Set(
				heritage
					.filter((edge) => edge.resolutionState === "resolved")
					.map((edge) => edge.targetName),
			);

			// Aliased (`CleanupCron`), grouped (`DataObject`, `Base`), absolute
			// (`\\Absolute\\Iface`) and same-namespace (`BaseService`) forms.
			// An alias resolves to what it points at, so the label is the real class
			// name: `use ... as CleanupCron` shows up as `Cleanup`.
			for (const name of [
				"Cleanup",
				"DataObject",
				"AbstractModel",
				"Iface",
				"BaseService",
				"LocalContract",
				"Thing",
			]) {
				expect(resolvedNames.has(name)).toBe(true);
			}

			// A class that exists nowhere on disk must not acquire a target. It is
			// `external` rather than `unresolved`: the name is known, its declaration
			// simply is not in the project.
			const missing = heritage.filter(
				(edge) => edge.targetName?.endsWith("MissingGeneratedFactory") === true,
			);
			expect(missing.length).toBeGreaterThan(0);
			expect(missing.every((edge) => edge.target === null)).toBe(true);
			expect(missing.every((edge) => edge.resolutionState === "external")).toBe(
				true,
			);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"scalar type positions produce no edges",
		async () => {
			const manifest = MANIFESTS.find(
				(candidate) => candidate.id === "php-types-enriched",
			);
			expect(manifest).toBeDefined();
			if (manifest === undefined) return;

			const { graph } = await runCleanPipeline(manifest);
			// Guard first: this fixture must actually produce type-position edges,
			// or "no scalar edges" is true of an empty graph.
			const typeEdges = graph.edges.filter(
				(edge) => edge.kind === "type_of" || edge.kind === "returns",
			);
			expect(typeEdges.length).toBeGreaterThan(0);

			const scalarTargets = graph.edges.filter((edge) =>
				["string", "float", "int", "bool"].includes(edge.targetName ?? ""),
			);
			expect(scalarTargets).toEqual([]);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("Pass-A-only PHP", () => {
	test(
		"declarations survive, semantic edges do not",
		async () => {
			const { graph } = await runCleanPipeline(PASS_A_CALLS);
			expect(new Set(graph.edges.map((edge) => edge.kind))).toEqual(
				new Set(["contains"]),
			);
			expect(graph.nodes.some((node) => node.name === "bucketOne")).toBe(true);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"a reverse question admits the capability is missing",
		async () => {
			await withPipeline(PASS_A_CALLS, async (session) => {
				await session.indexAll();
				const callers = await session.astrograph.callers({ symbol: "run" });
				expect(callers.data).toEqual([]);
				expect(callers.meta.partial).toBe(true);
				expect(
					(callers.meta.reasons ?? []).map((reason) => reason.kind),
				).toContain("capability_unsupported");
			});
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});
