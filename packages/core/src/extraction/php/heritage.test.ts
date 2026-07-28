import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FIXTURES_ROOT, PINNED_NOW } from "../../../__fixtures__/harness";
import { openProject } from "../../adapters/bun/project";
import type { Astrograph } from "../../astrograph";
import { normalize } from "../../testing/normalize";
import type { Edge, Node } from "../../types";

const HERITAGE_ROOT = `${FIXTURES_ROOT}/php/heritage`;
const GOLDEN_PATH = `${HERITAGE_ROOT}/__golden__/graph.json`;

let graph: Astrograph;

beforeAll(async () => {
	graph = await openProject(HERITAGE_ROOT, {
		dbPath: ":memory:",
		now: () => PINNED_NOW,
		config: { backends: { typescript: { enabled: false } } },
	});
	await graph.indexAll();
});

afterAll(() => {
	graph.close();
});

describe("PHP heritage resolution (extends/implements)", () => {
	test("aliased use resolves extends to the target class", () => {
		const child = mustNode("Child");
		const cleanup = mustNode("Cleanup");
		const edge = heritage(child, "extends", "Cleanup");
		expect(edge).toMatchObject({
			target: cleanup.id,
			resolutionState: "resolved",
			confidence: "high",
			provenance: "tree-sitter",
		});
	});

	test("plain use resolves implements to the target interface", () => {
		const child = mustNode("Child");
		const thing = mustNode("Thing");
		const edge = heritage(child, "implements", "Thing");
		expect(edge).toMatchObject({
			target: thing.id,
			resolutionState: "resolved",
			confidence: "high",
			provenance: "tree-sitter",
		});
	});

	test("leading-backslash absolute reference resolves without a use", () => {
		const child = mustNode("Child");
		const iface = mustNode("Iface");
		const edge = heritage(child, "implements", "Iface");
		expect(edge).toMatchObject({
			target: iface.id,
			resolutionState: "resolved",
			confidence: "high",
		});
	});

	test("missing on-disk class is external, never resolved from a bare name", () => {
		const child = mustNode("Child");
		const edge = graph.queries
			.getEdgesBySource(child.id)
			.find(
				(e) =>
					e.kind === "implements" &&
					e.targetName === "App\\Code\\MissingGeneratedFactory",
			);
		expect(edge).toBeDefined();
		expect(edge!.resolutionState).toBe("external");
		expect(edge!.target).toBeNull();
		expect(edge!.confidence).toBe("high");
	});

	test("same-namespace reference with no use resolves via current namespace", () => {
		const deep = mustNode("DeepChild");
		const base = mustNode("BaseService");
		const contract = mustNode("LocalContract");
		expect(heritage(deep, "extends", "BaseService")).toMatchObject({
			target: base.id,
			resolutionState: "resolved",
		});
		expect(heritage(deep, "implements", "LocalContract")).toMatchObject({
			target: contract.id,
			resolutionState: "resolved",
		});
	});

	test("grouped use: plain member and aliased member both resolve", () => {
		const usesGrouped = mustNode("UsesGrouped");
		const usesAlias = mustNode("UsesGroupedAlias");
		const dataObject = mustNode("DataObject");
		const abstractModel = mustNode("AbstractModel");
		expect(heritage(usesGrouped, "extends", "DataObject")).toMatchObject({
			target: dataObject.id,
			resolutionState: "resolved",
		});
		expect(heritage(usesAlias, "extends", "AbstractModel")).toMatchObject({
			target: abstractModel.id,
			resolutionState: "resolved",
		});
	});

	test("multi-level namespace FQNs are distinct from short names", () => {
		const deep = mustNode("DeepChild");
		expect(deep.filePath).toBe("DeepChild.php");
		const edge = heritage(deep, "extends", "BaseService");
		expect(edge?.resolutionState).toBe("resolved");
		// Must not have falsely resolved to a different BaseService via bare name.
		expect(edge?.target).toBe(mustNode("BaseService").id);
	});

	test("use declarations become followable imports edges, not leaf import nodes", () => {
		const imports = graph.queries
			.getAllNodes()
			.filter((node) => node.kind === "import");
		expect(imports).toEqual([]);

		const childFile = graph.queries
			.getAllNodes()
			.find((node) => node.kind === "file" && node.name === "Child.php");
		expect(childFile).toBeDefined();
		const importEdges = graph.queries
			.getEdgesBySource(childFile!.id)
			.filter((edge) => edge.kind === "imports");
		expect(importEdges.length).toBeGreaterThan(0);
		expect(
			importEdges.every(
				(edge) =>
					edge.resolutionState === "resolved" ||
					edge.resolutionState === "external",
			),
		).toBe(true);
	});

	test("normalized graph matches golden", async () => {
		const nodes = graph.queries.getAllNodes().filter((n) => !n.isExternal);
		const edges = graph.queries.getAllEdges();
		const normalized = normalize({ nodes, edges }, { rootPath: HERITAGE_ROOT });

		if (Bun.env.UPDATE_GOLDENS === "1") {
			const dir = GOLDEN_PATH.slice(0, GOLDEN_PATH.lastIndexOf("/"));
			await Bun.$`mkdir -p ${dir}`.quiet();
			await Bun.write(GOLDEN_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
			return;
		}

		const goldenFile = Bun.file(GOLDEN_PATH);
		expect(await goldenFile.exists()).toBe(true);
		const golden = await goldenFile.json();
		expect(normalized).toEqual(golden);
	});
});

function mustNode(name: string): Node {
	const node = graph.queries
		.getAllNodes()
		.find((candidate) => candidate.name === name && !candidate.isExternal);
	if (node === undefined) throw new Error(`Missing node ${name}`);
	return node;
}

function heritage(
	source: Node,
	kind: "extends" | "implements",
	targetName: string,
): Edge | undefined {
	return graph.queries
		.getEdgesBySource(source.id)
		.find((edge) => edge.kind === kind && edge.targetName === targetName);
}
