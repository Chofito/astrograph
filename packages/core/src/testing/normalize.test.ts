import { describe, expect, test } from "bun:test";
import { normalize } from "./normalize";
import type { Edge, Node } from "../types";

describe("normalize", () => {
	test("drops volatile fields, strips absolute roots, and sorts deterministically", () => {
		const nodes: Node[] = [
			makeNode({
				id: "node:b",
				filePath: "/repo/src/b.ts",
				qualifiedName: "/repo/src/b.ts::b",
				range: { startLine: 5, endLine: 6, startColumn: 0, endColumn: 1 },
				updatedAt: 200,
			}),
			makeNode({
				id: "node:a",
				filePath: "/repo/src/a.ts",
				qualifiedName: "/repo/src/a.ts::a",
				range: { startLine: 1, endLine: 2, startColumn: 0, endColumn: 1 },
				updatedAt: 100,
			}),
		];
		const edges: Edge[] = [
			makeEdge({
				id: 2,
				source: "node:b",
				target: "node:a",
				kind: "references",
				line: 2,
			}),
			makeEdge({
				id: 1,
				source: "node:a",
				target: "node:b",
				kind: "calls",
				line: 1,
			}),
		];

		const graph = normalize({ nodes, edges }, { rootPath: "/repo" });

		expect(graph.nodes.map((node) => node.filePath)).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
		expect(graph.nodes.map((node) => "updatedAt" in node)).toEqual([
			false,
			false,
		]);
		expect(graph.edges.map((edge) => edge.source)).toEqual([
			"node:a",
			"node:b",
		]);
		expect(graph.edges.map((edge) => "id" in edge)).toEqual([false, false]);
	});
});

function makeNode(overrides: Partial<Node>): Node {
	return {
		id: "node:default",
		project: "root",
		kind: "function",
		name: "defaultName",
		qualifiedName: "src/default.ts::defaultName",
		filePath: "src/default.ts",
		language: "typescript",
		range: {
			startLine: 1,
			endLine: 5,
			startColumn: 0,
			endColumn: 1,
		},
		isExported: false,
		isAsync: false,
		isStatic: false,
		isAbstract: false,
		isExternal: false,
		isGenerated: false,
		isTest: false,
		updatedAt: 100,
		...overrides,
	};
}

function makeEdge(overrides: Partial<Edge>): Edge {
	return {
		source: "node:source",
		target: "node:target",
		kind: "calls",
		resolutionState: "resolved",
		confidence: "high",
		provenance: "ts-compiler",
		line: 1,
		col: 0,
		...overrides,
	};
}
