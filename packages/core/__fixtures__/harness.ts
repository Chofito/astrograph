import { TsExtractor } from "../src/extraction/extractor";
import { nodeIdSet } from "../src/testing/graph-assertions";
import { normalize, type NormalizedGraph } from "../src/testing/normalize";
import type { Edge, ExtractionError, Hasher, Node } from "../src/types";

export const FIXTURES_ROOT = import.meta.dir;
export const PINNED_NOW = 1_700_000_000_000;

export const FIXTURE_HASHER: Hasher = {
	hash(content) {
		return String(Bun.hash(content));
	},
};

export interface FixtureExtractResult {
	relPath: string;
	nodes: Node[];
	edges: Edge[];
	externalNodes: Node[];
	errors: ExtractionError[];
}

function fixturePathJoin(...parts: string[]): string {
	return parts
		.filter((part) => part.length > 0)
		.join("/")
		.replaceAll("//", "/");
}

export async function fixtureRelPath(fixturePath: string): Promise<string> {
	const tsxPath = fixturePathJoin(FIXTURES_ROOT, fixturePath, "sample.tsx");
	if (await Bun.file(tsxPath).exists()) {
		return `${fixturePath}/sample.tsx`;
	}
	return `${fixturePath}/sample.ts`;
}

export async function readFixtureSource(fixturePath: string): Promise<string> {
	const relPath = await fixtureRelPath(fixturePath);
	return Bun.file(fixturePathJoin(FIXTURES_ROOT, relPath)).text();
}

async function listFixtureSourceFiles(fixturePath: string): Promise<string[]> {
	const dir = fixturePathJoin(FIXTURES_ROOT, fixturePath);
	const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs,cjs}");
	const files: string[] = [];

	for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
		const normalized = rel.replaceAll("\\", "/");
		if (normalized.includes("__golden__/")) continue;
		const base = normalized.split("/").pop() ?? "";
		if (base === "sample.ts" || base === "sample.tsx") continue;
		files.push(fixturePathJoin(fixturePath, normalized));
	}

	return files.sort();
}

/** Pass A + Pass B over all sources in a fixture directory (multi-file). */
export async function extractFixtureDirectory(
	fixturePath: string,
): Promise<FixtureExtractResult> {
	const relPaths = await listFixtureSourceFiles(fixturePath);
	if (relPaths.length === 0) {
		return extractFixtureFull(fixturePath);
	}

	const nodesByFile = new Map<string, Node[]>();
	const extractor = new TsExtractor({
		hasher: FIXTURE_HASHER,
		now: () => PINNED_NOW,
		project: "fixture",
	});

	extractor.loadProject({
		rootPath: FIXTURES_ROOT,
		fileNames: relPaths,
		loadNodesForFile: (filePath) => nodesByFile.get(filePath) ?? [],
	});

	const errors: ExtractionError[] = [];
	const allEdges: Edge[] = [];
	const externalById = new Map<string, Node>();

	for (const relPath of relPaths) {
		const source = await Bun.file(
			fixturePathJoin(FIXTURES_ROOT, relPath),
		).text();
		const passA = extractor.extractNodes(relPath, source);
		nodesByFile.set(relPath, passA.nodes);
		errors.push(...passA.errors);
	}

	for (const relPath of relPaths) {
		const passB = extractor.resolveEdges(relPath);
		allEdges.push(...passB.edges);
		errors.push(...passB.errors);
		for (const node of passB.externalNodes) {
			externalById.set(node.id, node);
		}
	}

	const nodes = relPaths.flatMap((relPath) => nodesByFile.get(relPath) ?? []);

	return {
		relPath: relPaths[0] ?? fixturePath,
		nodes,
		edges: allEdges,
		externalNodes: [...externalById.values()],
		errors,
	};
}

/** Uses multi-file extract when the fixture dir has sources besides sample.ts. */
export async function extractFixture(
	fixturePath: string,
): Promise<FixtureExtractResult> {
	if ((await listFixtureSourceFiles(fixturePath)).length > 0) {
		return extractFixtureDirectory(fixturePath);
	}
	return extractFixtureFull(fixturePath);
}

/** Pass A + Pass B over a single-file fixture directory. */
export async function extractFixtureFull(
	fixturePath: string,
): Promise<FixtureExtractResult> {
	const relPath = await fixtureRelPath(fixturePath);
	const source = await readFixtureSource(fixturePath);
	const nodesByFile = new Map<string, Node[]>();

	const extractor = new TsExtractor({
		hasher: FIXTURE_HASHER,
		now: () => PINNED_NOW,
		project: "fixture",
	});

	extractor.loadProject({
		rootPath: FIXTURES_ROOT,
		fileNames: [relPath],
		loadNodesForFile: (filePath) => nodesByFile.get(filePath) ?? [],
	});

	const passA = extractor.extractNodes(relPath, source);
	nodesByFile.set(relPath, passA.nodes);

	const passB = extractor.resolveEdges(relPath);

	return {
		relPath,
		nodes: passA.nodes,
		edges: passB.edges,
		externalNodes: passB.externalNodes,
		errors: [...passA.errors, ...passB.errors],
	};
}

/** Project + external nodes, as stored by the indexer after Pass B. */
export function graphFromFixture(result: FixtureExtractResult): {
	nodes: Node[];
	edges: Edge[];
} {
	return {
		nodes: [...result.nodes, ...result.externalNodes],
		edges: result.edges,
	};
}

/**
 * Stable snapshot for goldens: project nodes only, external edge targets
 * compared via targetName + resolutionState (ids vary with lib.d.ts paths).
 */
export function normalizeFixtureGraph(
	result: FixtureExtractResult,
): NormalizedGraph {
	const raw = graphFromFixture(result);
	const projectNodes = raw.nodes.filter((node) => !node.isExternal);
	const projectIds = nodeIdSet(projectNodes);
	const edges = raw.edges.map((edge) => {
		if (edge.target !== null && !projectIds.has(edge.target)) {
			return { ...edge, target: null };
		}
		return edge;
	});
	return normalize({ nodes: projectNodes, edges }, { rootPath: FIXTURES_ROOT });
}
