import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "../types";
import {
	assertGraphIntegrity,
	assertNoDanglingResolved,
	assertUniqueEdgeKeys,
	edgeDedupKey,
} from "./graph-assertions";

function node(id: string): Node {
	return {
		id,
		project: "p",
		kind: "function",
		name: "f",
		qualifiedName: "f.ts::f",
		filePath: "f.ts",
		language: "typescript",
		range: { startLine: 1, endLine: 1, startColumn: 0, endColumn: 1 },
		isExported: true,
		isAsync: false,
		isStatic: false,
		isAbstract: false,
		isExternal: false,
		isGenerated: false,
		isTest: false,
		updatedAt: 0,
	};
}

function edge(overrides: Partial<Edge> & Pick<Edge, "source" | "kind">): Edge {
	return {
		target: null,
		resolutionState: "unresolved",
		confidence: "low",
		provenance: "heuristic",
		...overrides,
	};
}

describe("graph-assertions", () => {
	test("assertNoDanglingResolved passes when targets exist", () => {
		const nodes = [node("a"), node("b")];
		const edges = [
			edge({
				source: "a",
				target: "b",
				kind: "calls",
				resolutionState: "resolved",
				confidence: "high",
				provenance: "ts-compiler",
			}),
		];
		assertNoDanglingResolved(edges, nodes);
	});

	test("assertNoDanglingResolved fails on missing resolved target", () => {
		const edges = [
			edge({
				source: "a",
				target: "missing",
				kind: "calls",
				resolutionState: "resolved",
				confidence: "high",
				provenance: "ts-compiler",
			}),
		];
		expect(() => assertNoDanglingResolved(edges, [node("a")])).toThrow();
	});

	test("assertUniqueEdgeKeys detects duplicate dedup keys", () => {
		const e = edge({
			source: "a",
			target: "b",
			kind: "calls",
			line: 1,
			resolutionState: "resolved",
			confidence: "high",
			provenance: "ts-compiler",
		});
		expect(() => assertUniqueEdgeKeys([e, { ...e }])).toThrow();
		expect(edgeDedupKey(e)).toBe("a\u0000calls\u0000b\u00001");
	});

	test("assertGraphIntegrity combines dangling and dedup checks", () => {
		assertGraphIntegrity({
			nodes: [node("a"), node("b")],
			edges: [
				edge({
					source: "a",
					target: "b",
					kind: "calls",
					line: 2,
					resolutionState: "resolved",
					confidence: "high",
					provenance: "ts-compiler",
				}),
			],
		});
	});
});
