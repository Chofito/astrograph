import { beforeAll, describe, expect, test } from "bun:test";
import { reconcileNodes } from "../src/extraction/reconcile";
import {
	initTreeSitter,
	loadGrammars,
} from "../src/extraction/tree-sitter/grammars";
import { TreeSitterParser } from "../src/extraction/tree-sitter/parser";
import type { Node } from "../src/types";
import {
	extractFixture,
	FIXTURE_HASHER,
	listFixtureSourceFiles,
	PINNED_NOW,
	readFixtureFileSource,
} from "./harness";

// The same 11 fixtures the golden graph suite in extraction.test.ts covers —
// this test does not touch __golden__/graph.json, it only compares node ids
// between Pass A (tree-sitter) and Pass B (the TS compiler enricher).
const FIXTURES = [
	"basic",
	"functions",
	"jsx",
	"decorators",
	"exports",
	"overloads",
	"imports/barrel",
	"imports/commonjs",
	"imports/type-only",
	"imports/dynamic-literal",
	"resolution/ambiguous",
] as const;

beforeAll(async () => {
	await initTreeSitter();
	await loadGrammars(["typescript", "tsx", "javascript", "jsx"]);
});

/** Pass A node set for every source file in a fixture, tree-sitter only. */
async function passANodesForFixture(fixturePath: string): Promise<Node[]> {
	const parser = new TreeSitterParser({
		hasher: FIXTURE_HASHER,
		now: () => PINNED_NOW,
		project: "fixture",
	});
	const relPaths = await listFixtureSourceFiles(fixturePath);
	const nodes: Node[] = [];
	for (const relPath of relPaths) {
		const source = await readFixtureFileSource(relPath);
		const result = parser.extractNodes(relPath, source);
		nodes.push(...result.nodes);
	}
	return nodes;
}

describe("Pass A (tree-sitter) is a conservative subset of Pass B (TS compiler)", () => {
	for (const fixture of FIXTURES) {
		test(`${fixture}: every Pass A node id exists in the enricher's node set (dropped === 0)`, async () => {
			const enrichedNodes = (await extractFixture(fixture)).nodes;
			const passANodes = await passANodesForFixture(fixture);

			// A vacuous pass (e.g. the grammar failed to load and only file nodes
			// were emitted) would trivially satisfy dropped === 0 without proving
			// anything, so guard that Pass A actually found real declarations.
			const passASymbolCount = passANodes.filter(
				(n) => n.kind !== "file",
			).length;
			expect(passASymbolCount).toBeGreaterThan(0);

			const plan = reconcileNodes(passANodes, enrichedNodes);

			expect(plan.delete).toEqual([]);
			expect(plan.stats.dropped).toBe(0);
			expect(plan.errors).toEqual([]);
		});
	}

	test("aggregate: no fixture drops a Pass A node across the whole golden set", async () => {
		let totalDropped = 0;
		let totalSymbols = 0;
		for (const fixture of FIXTURES) {
			const enrichedNodes = (await extractFixture(fixture)).nodes;
			const passANodes = await passANodesForFixture(fixture);
			totalSymbols += passANodes.filter((n) => n.kind !== "file").length;
			totalDropped += reconcileNodes(passANodes, enrichedNodes).stats.dropped;
		}
		expect(totalSymbols).toBeGreaterThan(0);
		expect(totalDropped).toBe(0);
	});
});
