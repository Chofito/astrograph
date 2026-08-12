import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FIXTURES_ROOT, PINNED_NOW } from "../../../__fixtures__/harness";
import { openProject } from "../../adapters/bun/project";
import type { Astrograph } from "../../astrograph";
import { normalize } from "../../testing/normalize";
import type { Edge, Node } from "../../types";

const CALLS_ROOT = `${FIXTURES_ROOT}/php/calls`;
const GOLDEN_PATH = `${CALLS_ROOT}/__golden__/graph.json`;

let graph: Astrograph;

beforeAll(async () => {
	graph = await openProject(CALLS_ROOT, {
		dbPath: ":memory:",
		now: () => PINNED_NOW,
		config: { backends: { typescript: { enabled: false } } },
	});
	await graph.indexAll();
});

afterAll(() => {
	graph.close();
});

describe("PHP call / instantiates resolution (STEP 3)", () => {
	test("bucket 1: promoted, typed, constructor-assigned, interface, parent, static, new", () => {
		const bucketOne = mustNode("bucketOne");
		const run = mustNode("run");
		const ping = mustNode("ping");
		const staticOk = mustNode("staticOk");
		const ctor = mustNode("__construct");

		expect(call(bucketOne, "run")?.target).toBe(run.id);
		expect(call(bucketOne, "run")?.resolutionState).toBe("resolved");
		expect(call(bucketOne, "ping")?.target).toBe(ping.id);
		expect(call(bucketOne, "staticOk")?.target).toBe(staticOk.id);

		const inst = graph.queries
			.getEdgesBySource(bucketOne.id)
			.find((edge) => edge.kind === "instantiates");
		expect(inst?.resolutionState).toBe("resolved");
		expect(
			inst?.target === ctor.id || inst?.target === mustNode("Dep").id,
		).toBe(true);
	});

	test("bucket 1: parent:: and inherited $this method", () => {
		const go = mustNode("go");
		const inherited = mustNode("inherited");
		const edges = graph.queries
			.getEdgesBySource(go.id)
			.filter((edge) => edge.kind === "calls" && edge.target === inherited.id);
		expect(edges.length).toBeGreaterThanOrEqual(1);
		expect(edges.every((edge) => edge.resolutionState === "resolved")).toBe(
			true,
		);
	});

	test("bucket 2: method only on vendor ancestor is external, not unresolved", () => {
		const loadRow = mustNode("loadRow");
		const edge = graph.queries
			.getEdgesBySource(loadRow.id)
			.find(
				(e) => e.kind === "calls" && (e.targetName ?? "").includes("getData"),
			);
		expect(edge).toBeDefined();
		expect(edge?.resolutionState).toBe("external");
		expect(edge?.target).toBeNull();
		expect(edge?.confidence).toBe("high");
	});

	test("bucket 3: missing in-project method is unresolved with a warning", () => {
		const nope = mustNode("nope");
		const edge = graph.queries
			.getEdgesBySource(nope.id)
			.find((e) => e.kind === "calls");
		expect(edge?.resolutionState).toBe("unresolved");
		expect(edge?.confidence).toBe("low");
		const file = graph.queries.getFile("MissingCall.php");
		expect(
			file?.errors?.some((error) => error.code === "PHP_CALL_UNRESOLVED") ??
				false,
		).toBe(true);
	});

	test("bucket 4: unknown receiver is unresolved without a name-only fallback", () => {
		const wild = mustNode("wild");
		const edge = graph.queries
			.getEdgesBySource(wild.id)
			.find((e) => e.kind === "calls");
		expect(edge?.resolutionState).toBe("unresolved");
		expect(edge?.target).toBeNull();
		expect(edge?.targetName).toBe("foo");
	});

	test("normalized graph matches golden", async () => {
		const nodes = graph.queries.getAllNodes().filter((n) => !n.isExternal);
		const edges = graph.queries.getAllEdges();
		const normalized = normalize({ nodes, edges }, { rootPath: CALLS_ROOT });

		if (Bun.env.UPDATE_GOLDENS === "1") {
			const dir = GOLDEN_PATH.slice(0, GOLDEN_PATH.lastIndexOf("/"));
			await Bun.$`mkdir -p ${dir}`.quiet();
			await Bun.write(GOLDEN_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
			return;
		}

		const goldenFile = Bun.file(GOLDEN_PATH);
		expect(await goldenFile.exists()).toBe(true);
		expect(normalized).toEqual(await goldenFile.json());
	});
});

function mustNode(name: string): Node {
	const node = graph.queries
		.getAllNodes()
		.find((candidate) => candidate.name === name && !candidate.isExternal);
	if (node === undefined) throw new Error(`Missing node ${name}`);
	return node;
}

function call(source: Node, targetName: string): Edge | undefined {
	return graph.queries
		.getEdgesBySource(source.id)
		.find((edge) => edge.kind === "calls" && edge.targetName === targetName);
}
