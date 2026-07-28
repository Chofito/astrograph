import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FIXTURES_ROOT, PINNED_NOW } from "../../../__fixtures__/harness";
import { openProject } from "../../adapters/bun/project";
import type { Astrograph } from "../../astrograph";
import { normalize } from "../../testing/normalize";
import type { Edge, Node } from "../../types";

const TYPES_ROOT = `${FIXTURES_ROOT}/php/types`;
const GOLDEN_PATH = `${TYPES_ROOT}/__golden__/graph.json`;

let graph: Astrograph;

beforeAll(async () => {
	graph = await openProject(TYPES_ROOT, {
		dbPath: ":memory:",
		now: () => PINNED_NOW,
		config: { backends: { typescript: { enabled: false } } },
	});
	await graph.indexAll();
});

afterAll(() => {
	graph.close();
});

describe("PHP type-position edges (type_of / returns) and imports", () => {
	test("does not emit leaf import nodes", () => {
		const imports = graph.queries
			.getAllNodes()
			.filter((node) => node.kind === "import");
		expect(imports).toEqual([]);
	});

	test("use declarations become imports edges from the file node", () => {
		const file = mustNodeByKind("file", "Worker.php");
		const thing = mustNode("Thing");
		const cron = mustNode("CleanupCron");
		const edges = graph.queries
			.getEdgesBySource(file.id)
			.filter((edge) => edge.kind === "imports");
		expect(edges.length).toBeGreaterThanOrEqual(3);
		expect(
			edges.some(
				(edge) =>
					edge.target === thing.id && edge.resolutionState === "resolved",
			),
		).toBe(true);
		expect(
			edges.some(
				(edge) =>
					edge.target === cron.id && edge.resolutionState === "resolved",
			),
		).toBe(true);
	});

	test("typed property emits type_of", () => {
		const prop = mustNode("$cron");
		const cron = mustNode("CleanupCron");
		expect(typeEdge(prop, "type_of", "CleanupCron")).toMatchObject({
			target: cron.id,
			resolutionState: "resolved",
			confidence: "high",
			provenance: "tree-sitter",
		});
	});

	test("property_promotion_parameter emits type_of from the constructor", () => {
		const ctor = mustNode("__construct");
		const thing = mustNode("Thing");
		expect(typeEdge(ctor, "type_of", "Thing")).toMatchObject({
			target: thing.id,
			resolutionState: "resolved",
		});
	});

	test("simple_parameter emits type_of; scalars are skipped", () => {
		const ctor = mustNode("__construct");
		const cron = mustNode("CleanupCron");
		expect(typeEdge(ctor, "type_of", "CleanupCron")).toMatchObject({
			target: cron.id,
			resolutionState: "resolved",
		});
		const scalarEdges = graph.queries
			.getEdgesBySource(ctor.id)
			.filter(
				(edge) =>
					edge.kind === "type_of" &&
					(edge.targetName === "string" || edge.targetName === "float"),
			);
		expect(scalarEdges).toEqual([]);
	});

	test("return type emits returns; void/string scalars skipped", () => {
		const run = mustNode("run");
		const thing = mustNode("Thing");
		expect(typeEdge(run, "returns", "Thing")).toMatchObject({
			target: thing.id,
			resolutionState: "resolved",
		});
		const label = mustNode("label");
		expect(
			graph.queries
				.getEdgesBySource(label.id)
				.filter((edge) => edge.kind === "returns"),
		).toEqual([]);
	});

	test("missing return type FQN is external, not resolved", () => {
		const missing = mustNode("missing");
		const edge = graph.queries
			.getEdgesBySource(missing.id)
			.find((e) => e.kind === "returns");
		expect(edge).toMatchObject({
			target: null,
			targetName: "Vendor\\Missing\\Factory",
			resolutionState: "external",
			confidence: "high",
		});
	});

	test("normalized graph matches golden", async () => {
		const nodes = graph.queries.getAllNodes().filter((n) => !n.isExternal);
		const edges = graph.queries.getAllEdges();
		const normalized = normalize({ nodes, edges }, { rootPath: TYPES_ROOT });

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

function mustNodeByKind(kind: string, name: string): Node {
	const node = graph.queries
		.getAllNodes()
		.find(
			(candidate) =>
				candidate.kind === kind &&
				candidate.name === name &&
				!candidate.isExternal,
		);
	if (node === undefined) throw new Error(`Missing ${kind} ${name}`);
	return node;
}

function typeEdge(
	source: Node,
	kind: "type_of" | "returns",
	targetName: string,
): Edge | undefined {
	return graph.queries
		.getEdgesBySource(source.id)
		.find((edge) => edge.kind === kind && edge.targetName === targetName);
}
