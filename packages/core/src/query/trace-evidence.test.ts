import { describe, expect, test } from "bun:test";
import { BunSqliteStorageAdapter } from "../adapters/bun/sqlite";
import { runMigrations } from "../db/migrations";
import { QueryBuilder } from "../db/queries";
import { collectPathEvidence } from "../graph/path-evidence";
import { GraphQueries } from "./graph-queries";
import type {
	BackendStatus,
	Edge,
	FileRecord,
	FileSystem,
	Node,
	Range,
} from "../types";

/**
 * AG-209 findings 2 and 3.
 *
 * A `found: true` trace dropped the destination's unresolved callees, because
 * evidence was built from the resolved path only. A `found: false` trace
 * promised to explain itself but gathered blockers through `traverseGraph`,
 * which discards target-null edges before recording a visit — so it could never
 * see the hop that blocked the path.
 */

const NOW = 1_700_000_000_000;
const RANGE: Range = { startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 };

const BACKEND: BackendStatus = {
	id: "typescript",
	languages: ["typescript"],
	extensions: [".ts"],
	versions: {},
	enricher: "complement",
	capabilities: {
		edgeKinds: ["contains", "calls", "references", "instantiates"],
	},
	grammarsLoaded: [],
	grammarsUnavailable: [],
};

const NO_FS: FileSystem = {
	async readText() {
		return "";
	},
	async exists() {
		return false;
	},
	async stat() {
		return { size: 0, modifiedAt: NOW };
	},
};

function node(name: string): Node {
	return {
		id: `id:${name}`,
		project: "root",
		kind: "function",
		name,
		qualifiedName: `src/a.ts::${name}`,
		filePath: "src/a.ts",
		language: "typescript",
		range: RANGE,
		isExported: false,
		isAsync: false,
		isStatic: false,
		isAbstract: false,
		isExternal: false,
		isGenerated: false,
		isTest: false,
		updatedAt: NOW,
	};
}

function file(): FileRecord {
	return {
		path: "src/a.ts",
		project: "root",
		contentHash: "h",
		language: "typescript",
		size: 1,
		modifiedAt: NOW,
		indexedAt: NOW,
		nodeCount: 1,
		state: "resolved",
	};
}

function resolved(source: string, target: string): Edge {
	return {
		source: `id:${source}`,
		target: `id:${target}`,
		kind: "calls",
		resolutionState: "resolved",
		confidence: "high",
		provenance: "ts-compiler",
	};
}

function unresolved(source: string, targetName: string, line = 1): Edge {
	return {
		source: `id:${source}`,
		target: null,
		targetName,
		kind: "calls",
		resolutionState: "unresolved",
		confidence: "low",
		provenance: "ts-compiler",
		line,
	};
}

function missingTarget(source: string, target: string): Edge {
	return {
		source: `id:${source}`,
		target: `id:${target}`,
		targetName: target,
		kind: "calls",
		resolutionState: "resolved",
		confidence: "high",
		provenance: "ts-compiler",
	};
}

/** A minimal read port can represent a stale target that SQLite rightly refuses to persist. */
function pathEvidenceQueries(names: string[], edges: Edge[]) {
	const nodes = new Map<string, Node>(
		names.map((name): [string, Node] => [`id:${name}`, node(name)]),
	);
	return {
		getNode(id: string): Node | undefined {
			return nodes.get(id);
		},
		getEdgesBySource(id: string): Edge[] {
			return edges.filter((edge) => edge.source === id);
		},
	};
}

interface World {
	queries: QueryBuilder;
	graph: GraphQueries;
	close(): void;
}

/** Build a graph directly, so the shapes under test are exact. */
function world(names: string[], edges: Edge[]): World {
	const storage = new BunSqliteStorageAdapter(":memory:");
	runMigrations(storage, { now: () => NOW });
	const queries = new QueryBuilder(storage);
	queries.upsertFile(file());
	for (const name of names) queries.upsertNode(node(name));
	for (const edge of edges) queries.upsertEdge(edge);

	return {
		queries,
		graph: new GraphQueries({
			queries,
			fs: NO_FS,
			root: "/project",
			backends: [BACKEND],
		}),
		close: () => storage.close(),
	};
}

describe("a successful trace still reports what the destination could not reach", () => {
	test("found is true, the unresolved callee is not a node, but it is evidence", async () => {
		const w = world(
			["start", "middle", "dest"],
			[
				resolved("start", "middle"),
				resolved("middle", "dest"),
				// The destination calls something nobody could resolve.
				unresolved("dest", "mysteryCallee", 42),
			],
		);

		try {
			const result = await w.graph.trace({ from: "start", to: "dest" });

			expect(result.data.found).toBe(true);
			// The payload may only contain real nodes.
			expect(
				result.data.destinationCallees?.map((ref) => ref.name) ?? [],
			).not.toContain("mysteryCallee");

			// The relation must not vanish with it.
			const samples = result.meta.evidence?.samples ?? [];
			expect(samples.map((s) => s.targetName)).toContain("mysteryCallee");
			expect(samples.find((s) => s.targetName === "mysteryCallee")?.line).toBe(
				42,
			);
			expect(result.meta.partial).toBe(true);
		} finally {
			w.close();
		}
	});

	test("merging the path with the destination keeps counts exact", async () => {
		const w = world(
			["start", "dest"],
			[resolved("start", "dest"), unresolved("dest", "shared", 7)],
		);

		try {
			const result = await w.graph.trace({ from: "start", to: "dest" });
			const counts = result.meta.evidence?.counts ?? [];
			expect(
				counts.find(
					(c) => c.resolutionState === "unresolved" && c.kind === "calls",
				)?.count,
			).toBe(1);
			expect(
				counts.find(
					(c) => c.resolutionState === "resolved" && c.kind === "calls",
				)?.count,
			).toBe(1);
		} finally {
			w.close();
		}
	});
});

describe("a failed trace explains what blocked it", () => {
	test("an unresolved relation on the start node is reported", async () => {
		const w = world(
			["start", "dest"],
			[unresolved("start", "blockedHere", 3)],
		);

		try {
			const result = await w.graph.trace({ from: "start", to: "dest" });

			expect(result.data.found).toBe(false);
			expect(
				result.meta.evidence?.samples.map((s) => s.targetName),
			).toContain("blockedHere");
			expect(result.meta.reasons?.map((r) => r.kind)).toContain(
				"semantic_uncertainty",
			);
		} finally {
			w.close();
		}
	});

	test("a blocker behind one or more resolved hops is reported", async () => {
		const w = world(
			["start", "middle", "dest"],
			[resolved("start", "middle"), unresolved("middle", "blockedDeeper", 9)],
		);

		try {
			const result = await w.graph.trace({ from: "start", to: "dest" });

			expect(result.data.found).toBe(false);
			expect(
				result.meta.evidence?.samples.map((s) => s.targetName),
			).toContain("blockedDeeper");
		} finally {
			w.close();
		}
	});

	test("an unresolved edge on the depth frontier is not presented as inspected or truncated", async () => {
		const w = world(
			["start", "middle", "dest"],
			[resolved("start", "middle"), unresolved("middle", "tooFarAway")],
		);

		try {
			// maxDepth 1 expands only from `start`; the frontier is checked only to
			// decide whether a further walk was possible, not to report its relation
			// as a blocker. Claiming otherwise would be a fabricated observation.
			const shallow = await w.graph.trace({
				from: "start",
				to: "dest",
				maxDepth: 1,
			});
			expect(
				shallow.meta.evidence?.samples.map((s) => s.targetName) ?? [],
			).not.toContain("tooFarAway");
			// An unresolved edge cannot advance the search, so reaching it at the
			// frontier exhausts the traversable graph rather than truncating it.
			expect(
				shallow.meta.reasons?.map((r) => r.kind) ?? [],
			).not.toContain("search_truncated");

			const deep = await w.graph.trace({
				from: "start",
				to: "dest",
				maxDepth: 3,
			});
			expect(
				deep.meta.evidence?.samples.map((s) => s.targetName) ?? [],
			).toContain("tooFarAway");
		} finally {
			w.close();
		}
	});

	test("a cycle on the depth frontier does not report search_truncated", async () => {
		const w = world(
			["start", "middle", "dest"],
			[resolved("start", "middle"), resolved("middle", "start")],
		);
		try {
			const result = await w.graph.trace({
				from: "start",
				to: "dest",
				maxDepth: 1,
			});
			expect(
				result.meta.reasons?.map((reason) => reason.kind) ?? [],
			).not.toContain("search_truncated");
		} finally {
			w.close();
		}
	});

	test("an unvisited valid target beyond maxDepth reports search_truncated", async () => {
		const w = world(
			["start", "middle", "later", "dest"],
			[resolved("start", "middle"), resolved("middle", "later")],
		);
		try {
			const result = await w.graph.trace({
				from: "start",
				to: "dest",
				maxDepth: 1,
			});
			expect(result.meta.reasons?.map((reason) => reason.kind)).toContain(
				"search_truncated",
			);
		} finally {
			w.close();
		}
	});

	test("an exhausted search is not reported as truncated", async () => {
		const w = world(["start", "dest"], []);
		try {
			const result = await w.graph.trace({ from: "start", to: "dest" });
			expect(result.data.found).toBe(false);
			// Nothing to follow: the graph ran out, the search was not cut short.
			expect(result.meta.reasons?.map((r) => r.kind) ?? []).not.toContain(
				"search_truncated",
			);
			expect(result.meta.notes?.join(" ")).toContain("fully searched");
		} finally {
			w.close();
		}
	});

	test("blocker order is stable across several relations", async () => {
		const w = world(
			["start", "dest"],
			[
				unresolved("start", "zeta", 3),
				unresolved("start", "alpha", 1),
				unresolved("start", "mid", 2),
			],
		);

		try {
			const first = await w.graph.trace({ from: "start", to: "dest" });
			const second = await w.graph.trace({ from: "start", to: "dest" });
			const names = first.meta.evidence?.samples.map((s) => s.targetName);
			expect(names).toEqual(["alpha", "mid", "zeta"]);
			expect(second.meta.evidence).toEqual(first.meta.evidence);
		} finally {
			w.close();
		}
	});

	test("no source text reaches metadata", async () => {
		const w = world(["start", "dest"], [unresolved("start", "blocked", 5)]);
		try {
			const result = await w.graph.trace({ from: "start", to: "dest" });
			const sample = result.meta.evidence?.samples[0] ?? {};
			expect(Object.keys(sample).sort()).toEqual([
				"kind",
				"line",
				"provenance",
				"resolutionState",
				"source",
				"targetName",
			]);
		} finally {
			w.close();
		}
	});
});

describe("collectPathEvidence", () => {
	test("a missing target on the depth frontier does not truncate the walk", () => {
		const walk = collectPathEvidence(
			pathEvidenceQueries(
				["start", "middle"],
				[resolved("start", "middle"), missingTarget("middle", "missing")],
			),
			{
				startId: "id:start",
				edgeKinds: ["calls"],
				maxDepth: 1,
				limit: 100,
			},
		);
		expect(walk.truncated).toBe(false);
	});

	test("collects an edge it cannot follow, which traverseGraph never could", () => {
		const w = world(
			["start", "middle"],
			[resolved("start", "middle"), unresolved("middle", "blocked")],
		);
		try {
			const walk = collectPathEvidence(w.queries, {
				startId: "id:start",
				edgeKinds: ["calls"],
				maxDepth: 6,
				limit: 100,
			});
			expect(walk.edges.map((e) => e.targetName ?? e.target)).toEqual([
				"id:middle",
				"blocked",
			]);
			expect(walk.inspected).toBe(2);
			expect(walk.truncated).toBe(false);
		} finally {
			w.close();
		}
	});

	test("an unknown start node yields nothing rather than throwing", () => {
		const w = world([], []);
		try {
			expect(
				collectPathEvidence(w.queries, {
					startId: "id:missing",
					edgeKinds: ["calls"],
					maxDepth: 3,
					limit: 10,
				}),
			).toEqual({ edges: [], inspected: 0, truncated: false });
		} finally {
			w.close();
		}
	});

	test("the node limit is honored and reported as truncation", () => {
		const w = world(
			["a", "b", "c"],
			[resolved("a", "b"), resolved("b", "c"), unresolved("c", "never")],
		);
		try {
			const walk = collectPathEvidence(w.queries, {
				startId: "id:a",
				edgeKinds: ["calls"],
				maxDepth: 10,
				limit: 1,
			});
			expect(walk.inspected).toBe(1);
			expect(walk.truncated).toBe(true);
			expect(walk.edges.map((e) => e.targetName ?? e.target)).not.toContain(
				"never",
			);
		} finally {
			w.close();
		}
	});
});
