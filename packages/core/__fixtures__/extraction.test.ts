import { describe, expect, test } from "bun:test";
import { TsExtractor } from "../src/extraction/extractor";
import {
	assertDeterministicNormalizedAsync,
	assertGraphIntegrity,
} from "../src/testing/graph-assertions";
import type { NormalizedGraph } from "../src/testing/normalize";
import {
	extractFixture,
	FIXTURE_HASHER,
	FIXTURES_ROOT,
	graphFromFixture,
	normalizeFixtureGraph,
	PINNED_NOW,
} from "./harness";

const UPDATE = Bun.env.UPDATE_GOLDENS === "1";

const GOLDEN_FIXTURES = [
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

function goldenGraphPath(fixturePath: string): string {
	return `${FIXTURES_ROOT}/${fixturePath}/__golden__/graph.json`;
}

async function loadGoldenGraph(
	fixturePath: string,
): Promise<NormalizedGraph | null> {
	const goldenPath = goldenGraphPath(fixturePath);
	if (!(await Bun.file(goldenPath).exists())) return null;
	const data = (await Bun.file(goldenPath).json()) as NormalizedGraph;
	if (
		(!data.nodes || data.nodes.length === 0) &&
		(!data.edges || data.edges.length === 0)
	) {
		return null;
	}
	return data;
}

async function saveGoldenGraph(
	fixturePath: string,
	graph: NormalizedGraph,
): Promise<void> {
	const goldenPath = goldenGraphPath(fixturePath);
	const goldenDir = goldenPath.slice(0, goldenPath.lastIndexOf("/"));
	await Bun.$`mkdir -p ${goldenDir}`.quiet();
	await Bun.write(goldenPath, `${JSON.stringify(graph, null, 2)}\n`);
}

async function assertGoldenGraph(fixturePath: string): Promise<void> {
	const result = await extractFixture(fixturePath);
	const graph = graphFromFixture(result);
	assertGraphIntegrity(graph);

	const normalized = normalizeFixtureGraph(result);

	if (UPDATE) {
		await saveGoldenGraph(fixturePath, normalized);
		return;
	}

	const golden = await loadGoldenGraph(fixturePath);
	if (golden === null) {
		throw new Error(
			`Missing golden for ${fixturePath}: run "bun packages/core/__fixtures__/update-goldens.ts ${fixturePath}" and review graph.json`,
		);
	}

	expect(normalized).toEqual(golden);
}

describe("extraction: golden graphs (Pass A + B)", () => {
	for (const fixture of GOLDEN_FIXTURES) {
		test(`${fixture} nodes and edges match graph.json`, async () => {
			await assertGoldenGraph(fixture);
		});
	}
});

describe("extraction: determinism", () => {
	test("full extract twice yields identical normalized graph", async () => {
		await assertDeterministicNormalizedAsync(async () =>
			normalizeFixtureGraph(await extractFixture("basic")),
		);
	});

	test("no id collisions within a fixture graph", async () => {
		for (const fixture of GOLDEN_FIXTURES) {
			const { nodes } = graphFromFixture(await extractFixture(fixture));
			const ids = nodes.map((n) => n.id);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});
});

describe("extraction: fixture invariants", () => {
	test("resolution/ambiguous golden includes ambiguous edges with candidates", async () => {
		const graph = graphFromFixture(await extractFixture("resolution/ambiguous"));
		const ambiguous = graph.edges.filter(
			(edge) => edge.resolutionState === "ambiguous",
		);
		expect(ambiguous.length).toBeGreaterThan(0);
		expect(
			ambiguous.some(
				(edge) =>
					Array.isArray(edge.metadata?.candidates) &&
					(edge.metadata!.candidates as string[]).length > 1,
			),
		).toBe(true);
	});

	test("imports/commonjs records require as external calls (imports/exports not yet modeled)", async () => {
		const graph = graphFromFixture(await extractFixture("imports/commonjs"));
		const requireCalls = graph.edges.filter(
			(edge) =>
				edge.kind === "calls" &&
				edge.targetName === "require" &&
				edge.resolutionState === "external",
		);
		expect(requireCalls.length).toBeGreaterThan(0);
	});
});

describe("extraction: error handling", () => {
	test("returns error when source is not a string", () => {
		const extractor = new TsExtractor({
			hasher: FIXTURE_HASHER,
			now: () => PINNED_NOW,
		});
		const result = extractor.extractNodes("bad.ts", null as unknown as string);
		expect(result.nodes).toEqual([]);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]!.severity).toBe("error");
		expect(result.errors[0]!.code).toBe("PARSE_ERROR");
	});
});

describe("extraction: resolveEdges without loaded project", () => {
	test("returns empty edges, errors, and external nodes", () => {
		const extractor = new TsExtractor({
			hasher: FIXTURE_HASHER,
			now: () => PINNED_NOW,
		});
		const result = extractor.resolveEdges("any.ts");
		expect(result.edges).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(result.externalNodes).toEqual([]);
	});
});
