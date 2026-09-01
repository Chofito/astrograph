import { describe, expect, test } from "bun:test";
import { BunSqliteStorageAdapter } from "./adapters/bun/sqlite";
import { runMigrations } from "./db/migrations";
import { QueryBuilder } from "./db/queries";
import { LanguageRegistry } from "./extraction/registry";
import { Indexer } from "./indexer";
import type {
	Edge,
	EdgeResolutionResult,
	FileSystem,
	GlobScanner,
	Hasher,
	InvalidationInput,
	LanguageBackend,
	Node,
	PassAResult,
	Range,
} from "./types";

/**
 * AG-204: invalidation belongs to the producing backend.
 *
 * The behavior being removed matched a bare `node.name` against every
 * unresolved edge in the graph and promoted whatever it found. That could link
 * a PHP `save()` to a TypeScript call, and two same-named symbols in different
 * namespaces to each other — a fabricated edge presented as `resolved`.
 */

const NOW = 1_700_000_000_000;
const RANGE: Range = { startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 };
const HASHER: Hasher = { hash: (c) => String(Bun.hash(c)) };

function node(filePath: string, name: string, language: string): Node {
	return {
		id: `${language}:${filePath}::${name}`,
		project: "root",
		kind: "function",
		name,
		qualifiedName: `${filePath}::${name}`,
		filePath,
		language,
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

interface Recorder {
	backend: LanguageBackend;
	/** Files this backend was asked to resolve, per invocation. */
	resolved: string[];
	invalidations: InvalidationInput[];
}

/**
 * A backend whose Pass A emits one node per whitespace-separated word, and
 * whose enricher emits an unresolved `calls` edge for any word suffixed `()`.
 */
function recordingBackend(
	id: string,
	extension: string,
	options: { invalidate?: boolean } = {},
): Recorder {
	const resolved: string[] = [];
	const invalidations: InvalidationInput[] = [];

	const words = (source: string) =>
		source.split(/\s+/).filter((w) => w.length > 0);

	return {
		resolved,
		invalidations,
		backend: {
			id,
			languages: [id],
			extensions: [extension],
			parser: {
				extractNodes(filePath: string, source: string): PassAResult {
					return {
						nodes: words(source)
							.filter((w) => !w.endsWith("()"))
							.map((name) => node(filePath, name, id)),
						edges: [],
						errors: [],
					};
				},
			},
			enricher: {
				mode: "complement",
				id: `${id}-enricher`,
				provenance: "synthesized:stub",
				loadProject: () => {},
				resolveEdges(filePath: string): EdgeResolutionResult {
					resolved.push(filePath);
					return { edges: [], errors: [], externalNodes: [] };
				},
				...(options.invalidate === false
					? {}
					: {
							invalidate: (input: InvalidationInput) => {
								invalidations.push(input);
								const affected = new Set<string>();
								for (const path of [...input.added, ...input.modified]) {
									affected.add(path);
									for (const dep of input.dependentsOf(path)) affected.add(dep);
								}
								for (const path of input.removed) {
									for (const dep of input.dependentsOf(path)) affected.add(dep);
								}
								return {
									resolveFiles: [...affected]
										.filter((p) => p.endsWith(extension))
										.sort(),
								};
							},
						}),
			},
			capabilities: { edgeKinds: ["contains", "calls"] },
			versionKeys: () => ({ parser: "1" }),
		},
	};
}

function memoryFs(files: Record<string, string>): FileSystem {
	return {
		async readText(path) {
			const c = files[path];
			if (c === undefined) throw new Error(`ENOENT: ${path}`);
			return c;
		},
		async exists(path) {
			return files[path] !== undefined;
		},
		async stat(path) {
			const c = files[path];
			if (c === undefined) throw new Error(`ENOENT: ${path}`);
			return { size: c.length, modifiedAt: NOW };
		},
	};
}

function memoryGlob(files: Record<string, string>): GlobScanner {
	return {
		async *scan() {
			for (const p of Object.keys(files).sort()) yield p;
		},
	};
}

function openIndexer(
	backends: LanguageBackend[],
	files: Record<string, string>,
): { indexer: Indexer; queries: QueryBuilder; storage: BunSqliteStorageAdapter } {
	const storage = new BunSqliteStorageAdapter(":memory:");
	runMigrations(storage, { now: () => NOW });
	const queries = new QueryBuilder(storage);
	const absolute = Object.fromEntries(
		Object.entries(files).map(([p, c]) => [`/project/${p}`, c]),
	);

	const indexer = new Indexer({
		queries,
		storage,
		fs: memoryFs(absolute),
		hasher: HASHER,
		glob: memoryGlob(files),
		registry: new LanguageRegistry(backends),
		root: "/project",
		now: () => NOW,
	});
	return { indexer, queries, storage };
}

describe("core never promotes an edge by name", () => {
	test("a same-named declaration in another language does not resolve an edge", async () => {
		const ts = recordingBackend("ts", ".ts");
		const php = recordingBackend("php", ".php");

		const files: Record<string, string> = {
			"src/consumer.ts": "run",
			"src/Model.php": "Model",
		};
		const { indexer, queries, storage } = openIndexer(
			[ts.backend, php.backend],
			files,
		);

		try {
			await indexer.indexAll();

			// A TypeScript call nobody could prove a target for.
			const consumer = queries
				.getNodesByFile("src/consumer.ts")
				.find((n) => n.name === "run");
			expect(consumer).toBeDefined();
			const unresolved: Edge = {
				source: consumer?.id ?? "",
				target: null,
				targetName: "save",
				kind: "calls",
				resolutionState: "unresolved",
				confidence: "low",
				provenance: "tree-sitter",
			};
			queries.upsertEdge(unresolved);

			// Now a PHP class grows a `save` method with the very same name.
			files["/project/src/Model.php"] = "Model save";
			(files as Record<string, string>)["src/Model.php"] = "Model save";

			await indexer.sync();

			// The TypeScript edge must still be unresolved. Nothing in the project
			// proves that a PHP method is the target of a TypeScript call.
			const after = queries
				.getAllEdges()
				.filter((edge) => edge.targetName === "save");
			expect(after.length).toBe(1);
			expect(after[0]?.resolutionState).toBe("unresolved");
			expect(after[0]?.target).toBeNull();
		} finally {
			storage.close();
		}
	});

	test("storage exposes no lookup from targetName to edges", () => {
		// The primitive that made name promotion possible is gone, so a future
		// caller cannot rebuild the behavior by accident.
		const storage = new BunSqliteStorageAdapter(":memory:");
		runMigrations(storage, { now: () => NOW });
		try {
			const queries = new QueryBuilder(storage) as unknown as Record<
				string,
				unknown
			>;
			expect(queries.getEdgesByResolutionStateAndTargetName).toBeUndefined();
		} finally {
			storage.close();
		}
	});
});

describe("backends own their affected set", () => {
	test("each backend is asked, and only its own files come back", async () => {
		const ts = recordingBackend("ts", ".ts");
		const php = recordingBackend("php", ".php");
		const files: Record<string, string> = {
			"src/a.ts": "alpha",
			"src/B.php": "Beta",
		};
		const { indexer, storage } = openIndexer([ts.backend, php.backend], files);

		try {
			await indexer.indexAll();
			ts.resolved.length = 0;
			php.resolved.length = 0;

			files["/project/src/a.ts"] = "alpha gamma";
			files["src/a.ts"] = "alpha gamma";
			await indexer.sync();

			// Both backends were consulted about the change.
			expect(ts.invalidations.length).toBeGreaterThan(0);
			expect(php.invalidations.length).toBeGreaterThan(0);

			// Only the owner did work; PHP returned nothing for a .ts change.
			expect(ts.resolved).toContain("src/a.ts");
			expect(php.resolved).toEqual([]);
		} finally {
			storage.close();
		}
	});

	test("a backend cannot schedule work on another language's files", async () => {
		const greedy = recordingBackend("ts", ".ts");
		// A misbehaving backend that claims every file in the project.
		const enricher = greedy.backend.enricher;
		if (enricher !== undefined) {
			enricher.invalidate = (input) => ({
				resolveFiles: [
					...input.added,
					...input.modified,
					"src/B.php",
					"does/not/exist.ts",
				],
			});
		}
		const php = recordingBackend("php", ".php");

		const files: Record<string, string> = {
			"src/a.ts": "alpha",
			"src/B.php": "Beta",
		};
		const { indexer, storage } = openIndexer(
			[greedy.backend, php.backend],
			files,
		);

		try {
			await indexer.indexAll();
			greedy.resolved.length = 0;
			php.resolved.length = 0;

			files["/project/src/a.ts"] = "alpha gamma";
			files["src/a.ts"] = "alpha gamma";
			await indexer.sync();

			// Ownership is enforced by core, not trusted from the backend.
			expect(greedy.resolved).toEqual(["src/a.ts"]);
			expect(greedy.resolved).not.toContain("src/B.php");
			expect(greedy.resolved).not.toContain("does/not/exist.ts");
		} finally {
			storage.close();
		}
	});

	test("a removal hands the backend the identities that existed before it", async () => {
		const ts = recordingBackend("ts", ".ts");
		const files: Record<string, string> = {
			"src/a.ts": "alpha",
			"src/gone.ts": "ghost",
		};
		const { indexer, storage } = openIndexer([ts.backend], files);

		try {
			await indexer.indexAll();
			ts.invalidations.length = 0;

			delete files["/project/src/gone.ts"];
			delete files["src/gone.ts"];
			await indexer.sync();

			const input = ts.invalidations.at(-1);
			expect(input?.removed).toContain("src/gone.ts");
			// Captured before deletion, or the backend could not reason at all.
			expect(
				input?.priorIdentities.map((identity) => identity.qualifiedName),
			).toContain("src/gone.ts::ghost");
		} finally {
			storage.close();
		}
	});

	test("a backend without invalidate falls back to recorded dependents only", async () => {
		const plain = recordingBackend("ts", ".ts", { invalidate: false });
		const files: Record<string, string> = { "src/a.ts": "alpha" };
		const { indexer, storage } = openIndexer([plain.backend], files);

		try {
			await indexer.indexAll();
			plain.resolved.length = 0;

			files["/project/src/a.ts"] = "alpha beta";
			files["src/a.ts"] = "alpha beta";
			await indexer.sync();

			// The default is conservative but still evidence-based: the changed
			// file, plus whoever holds a recorded edge into it. Never a name match.
			expect(plain.resolved).toEqual(["src/a.ts"]);
		} finally {
			storage.close();
		}
	});
});
