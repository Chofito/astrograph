import { describe, expect, test } from "bun:test";
import { BunSqliteStorageAdapter } from "../adapters/bun/sqlite";
import { runMigrations } from "../db/migrations";
import { QueryBuilder } from "../db/queries";
import { Indexer } from "../indexer";
import type {
	EdgeResolutionResult,
	Enricher,
	FileSystem,
	GlobScanner,
	Hasher,
	LanguageBackend,
	Node,
	PassAResult,
	Provenance,
	Range,
} from "../types";
import { LanguageRegistry } from "./registry";

/**
 * Contract tests for the narrowed enricher seam, driven by stub backends
 * instead of TypeScript or PHP. What is asserted here must hold for *any*
 * backend: Pass A always runs, provenance comes from the producer, and a
 * complement enricher can never delete a Pass A row.
 */

const NOW = 1_700_000_000_000;
const RANGE: Range = { startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 };

const HASHER: Hasher = { hash: (content) => String(Bun.hash(content)) };

function stubNode(filePath: string, name: string): Node {
	return {
		id: `${filePath}::${name}`,
		project: "root",
		kind: "function",
		name,
		qualifiedName: `${filePath}::${name}`,
		filePath,
		language: "stub",
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

/** In-memory project: the indexer only needs stat/read/exists over these. */
function memoryFileSystem(files: Record<string, string>): FileSystem {
	return {
		async readText(path) {
			const content = files[path];
			if (content === undefined) throw new Error(`ENOENT: ${path}`);
			return content;
		},
		async exists(path) {
			return files[path] !== undefined;
		},
		async stat(path) {
			const content = files[path] ?? "";
			return { size: content.length, modifiedAt: NOW };
		},
	};
}

function memoryGlob(relPaths: string[]): GlobScanner {
	return {
		async *scan() {
			for (const relPath of relPaths) yield relPath;
		},
	};
}

interface StubBackendOptions {
	/** Names Pass A emits for every file. */
	passANames: string[];
	/** Names the enricher's node view emits; omit for a Pass-A-only backend. */
	enrichedNames?: string[];
	provenance?: Provenance;
}

interface StubBackend {
	backend: LanguageBackend;
	/** How many times Pass A parsed each file, to prove it runs exactly once. */
	passACalls: Map<string, number>;
}

function makeStubBackend(options: StubBackendOptions): StubBackend {
	const passACalls = new Map<string, number>();

	const parser = {
		extractNodes(filePath: string): PassAResult {
			passACalls.set(filePath, (passACalls.get(filePath) ?? 0) + 1);
			return {
				nodes: options.passANames.map((name) => stubNode(filePath, name)),
				edges: [],
				errors: [],
			};
		},
	};

	const enricher: Enricher | undefined =
		options.enrichedNames === undefined
			? undefined
			: {
					mode: "complement",
					id: "stub-enricher",
					provenance: options.provenance ?? "synthesized:stub",
					resolveEdges(filePath: string): EdgeResolutionResult {
						return {
							edges: [],
							errors: [],
							externalNodes: [],
							nodes: (options.enrichedNames ?? []).map((name) =>
								stubNode(filePath, name),
							),
						};
					},
				};

	return {
		passACalls,
		backend: {
			id: "stub",
			languages: ["stub"],
			extensions: [".stub"],
			parser,
			enricher,
			capabilities: {
				edgeKinds:
					enricher === undefined ? ["contains"] : ["contains", "calls"],
			},
			versionKeys: () => ({ parser: "1" }),
		},
	};
}

function makeIndexer(
	backend: LanguageBackend,
	files: Record<string, string>,
): { indexer: Indexer; queries: QueryBuilder } {
	const storage = new BunSqliteStorageAdapter(":memory:");
	runMigrations(storage, { now: () => NOW });
	const queries = new QueryBuilder(storage);
	const relPaths = Object.keys(files).sort();

	const indexer = new Indexer({
		queries,
		storage,
		fs: memoryFileSystem(
			Object.fromEntries(
				relPaths.map((relPath) => [
					`/project/${relPath}`,
					files[relPath] ?? "",
				]),
			),
		),
		hasher: HASHER,
		glob: memoryGlob(relPaths),
		registry: new LanguageRegistry([backend]),
		root: "/project",
		now: () => NOW,
	});

	return { indexer, queries };
}

describe("Pass-A-only backend", () => {
	test("a backend with no enricher reaches the resolved terminal state", async () => {
		const stub = makeStubBackend({ passANames: ["alpha"] });
		const { indexer, queries } = makeIndexer(stub.backend, {
			"src/a.stub": "alpha",
		});

		try {
			await indexer.indexAll();

			expect(queries.getFile("src/a.stub")?.state).toBe("resolved");
			expect(queries.getNodesByFile("src/a.stub").map((n) => n.name)).toEqual([
				"alpha",
			]);
			expect(queries.getStats().coverage).toMatchObject({
				total: 1,
				resolved: 1,
				parsed: 0,
			});
		} finally {
			indexer.close();
		}
	});

	test("Pass A runs exactly once per file, with or without an enricher", async () => {
		const passAOnly = makeStubBackend({ passANames: ["alpha"] });
		const enriched = makeStubBackend({
			passANames: ["alpha"],
			enrichedNames: ["alpha"],
		});

		for (const stub of [passAOnly, enriched]) {
			const { indexer } = makeIndexer(stub.backend, { "src/a.stub": "alpha" });
			try {
				await indexer.indexAll();
				expect(stub.passACalls.get("src/a.stub")).toBe(1);
			} finally {
				indexer.close();
			}
		}
	});
});

describe("complement enricher reconciliation", () => {
	test("reconciled nodes carry the producer's provenance, not ts-compiler", async () => {
		const stub = makeStubBackend({
			passANames: ["alpha"],
			enrichedNames: ["alpha", "beta"],
			provenance: "synthesized:stub",
		});
		const { indexer, queries } = makeIndexer(stub.backend, {
			"src/a.stub": "alpha beta",
		});

		try {
			await indexer.indexAll();

			const nodes = queries.getNodesByFile("src/a.stub");
			expect(nodes.map((n) => n.name).sort()).toEqual(["alpha", "beta"]);
			for (const node of nodes) {
				expect(node.metadata?.provenance).toBe("synthesized:stub");
			}
			// The matched id was updated in place, the enricher-only id inserted.
			expect(indexer.reconcileStats()).toMatchObject({ matched: 1, added: 1 });
		} finally {
			indexer.close();
		}
	});

	test("a Pass A node the enricher omits is kept and reported as evidence", async () => {
		const stub = makeStubBackend({
			passANames: ["alpha", "orphan"],
			enrichedNames: ["alpha"],
		});
		const { indexer, queries } = makeIndexer(stub.backend, {
			"src/a.stub": "alpha orphan",
		});

		try {
			await indexer.indexAll();

			const names = queries.getNodesByFile("src/a.stub").map((n) => n.name);
			expect(names.sort()).toEqual(["alpha", "orphan"]);
			expect(indexer.reconcileStats().dropped).toBe(1);

			const errors = queries.getFile("src/a.stub")?.errors ?? [];
			expect(errors.map((e) => e.code)).toContain("PASS_A_NODE_DROPPED");
		} finally {
			indexer.close();
		}
	});

	test("an enricher with no node view leaves Pass A's nodes untouched", async () => {
		const stub = makeStubBackend({
			passANames: ["alpha"],
			enrichedNames: undefined,
		});
		// Enricher present, but its result carries no `nodes`.
		const backend: LanguageBackend = {
			...stub.backend,
			enricher: {
				mode: "complement",
				id: "edges-only",
				provenance: "heuristic",
				resolveEdges: () => ({ edges: [], errors: [], externalNodes: [] }),
			},
			capabilities: { edgeKinds: ["contains", "calls"] },
		};
		const { indexer, queries } = makeIndexer(backend, {
			"src/a.stub": "alpha",
		});

		try {
			await indexer.indexAll();

			const nodes = queries.getNodesByFile("src/a.stub");
			expect(nodes.map((n) => n.name)).toEqual(["alpha"]);
			expect(nodes[0]?.metadata?.provenance).toBeUndefined();
			expect(queries.getFile("src/a.stub")?.state).toBe("resolved");
		} finally {
			indexer.close();
		}
	});
});
