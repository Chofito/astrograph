import { describe, expect, test } from "bun:test";
import { BunSqliteStorageAdapter } from "./adapters/bun/sqlite";
import { runMigrations } from "./db/migrations";
import { QueryBuilder } from "./db/queries";
import { LanguageRegistry } from "./extraction/registry";
import { Indexer } from "./indexer";
import { normalizeIndex } from "./testing/normalize";
import type { AstrographConfig } from "./config";
import type {
	EdgeResolutionResult,
	FileSystem,
	GlobScanner,
	Hasher,
	LanguageBackend,
	Node,
	PassAResult,
	Range,
	WatchEvent,
} from "./types";

/**
 * AG-203: a full index over a reused database must converge to the same graph a
 * clean index produces. Anything left over from a previous configuration is a
 * row that keeps answering queries after the file stopped belonging.
 */

const NOW = 1_700_000_000_000;
const RANGE: Range = { startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 };
const HASHER: Hasher = { hash: (content) => String(Bun.hash(content)) };

/** One node per file, named after its content, so edits change the graph. */
function node(filePath: string, name: string, language: string): Node {
	return {
		id: `${filePath}::${name}`,
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

function backend(id: string, extensions: string[]): LanguageBackend {
	return {
		id,
		languages: [id],
		extensions,
		parser: {
			extractNodes(filePath: string, source: string): PassAResult {
				return {
					nodes: source
						.split(/\s+/)
						.filter((name) => name.length > 0)
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
			resolveEdges: (): EdgeResolutionResult => ({
				edges: [],
				errors: [],
				externalNodes: [],
			}),
		},
		capabilities: { edgeKinds: ["contains", "calls"] },
		versionKeys: () => ({ parser: "1" }),
	};
}

const STUB = backend("stub", [".stub"]);
const OTHER = backend("other", [".other"]);

/** A project state: the files that exist and the configuration in force. */
interface ProjectState {
	files: Record<string, string>;
	config?: AstrographConfig;
	/** Backends registered for this state; omit for both. */
	backends?: LanguageBackend[];
}

function memoryFs(files: Record<string, string>): FileSystem {
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
			const content = files[path];
			if (content === undefined) throw new Error(`ENOENT: ${path}`);
			return { size: content.length, modifiedAt: NOW };
		},
	};
}

function memoryGlob(paths: string[]): GlobScanner {
	return {
		async *scan() {
			for (const path of [...paths].sort()) yield path;
		},
	};
}

function openIndexer(
	state: ProjectState,
	storage: BunSqliteStorageAdapter,
): { indexer: Indexer; queries: QueryBuilder } {
	const queries = new QueryBuilder(storage);
	const relPaths = Object.keys(state.files).sort();
	const absolute = Object.fromEntries(
		relPaths.map((p) => [`/project/${p}`, state.files[p] ?? ""]),
	);

	const indexer = new Indexer({
		queries,
		storage,
		fs: memoryFs(absolute),
		hasher: HASHER,
		glob: memoryGlob(relPaths),
		registry: new LanguageRegistry(state.backends ?? [STUB, OTHER]),
		root: "/project",
		now: () => NOW,
		...(state.config === undefined ? {} : { config: state.config }),
	});
	return { indexer, queries };
}

function freshStorage(): BunSqliteStorageAdapter {
	const storage = new BunSqliteStorageAdapter(":memory:");
	runMigrations(storage, { now: () => NOW });
	return storage;
}

/** Index `state` into an empty database and return the normalized result. */
async function cleanIndex(state: ProjectState) {
	const storage = freshStorage();
	const { indexer, queries } = openIndexer(state, storage);
	try {
		await indexer.indexAll();
		return normalizeIndex(queries);
	} finally {
		storage.close();
	}
}

/** Index `before`, then `after` over the same database. */
async function reusedIndex(before: ProjectState, after: ProjectState) {
	const storage = freshStorage();
	try {
		const first = openIndexer(before, storage);
		await first.indexer.indexAll();

		const second = openIndexer(after, storage);
		await second.indexer.indexAll();
		return normalizeIndex(second.queries);
	} finally {
		storage.close();
	}
}

async function expectConverges(before: ProjectState, after: ProjectState) {
	expect(await reusedIndex(before, after)).toEqual(await cleanIndex(after));
}

describe("indexAll converges on a reused database", () => {
	test("unchanged state is idempotent", async () => {
		const state: ProjectState = {
			files: { "src/a.stub": "alpha", "src/b.stub": "beta" },
		};
		await expectConverges(state, state);
	});

	test("a deleted file leaves nothing behind", async () => {
		await expectConverges(
			{ files: { "src/a.stub": "alpha", "src/gone.stub": "ghost" } },
			{ files: { "src/a.stub": "alpha" } },
		);
	});

	test("an edited file does not keep its old symbols", async () => {
		await expectConverges(
			{ files: { "src/a.stub": "alpha beta" } },
			{ files: { "src/a.stub": "alpha gamma" } },
		);
	});

	test("a file that leaves the scan scope is retired", async () => {
		// The second state simply never yields the path, which is what an
		// `exclude` change looks like from the indexer's side.
		await expectConverges(
			{ files: { "src/a.stub": "alpha", "vendor/x.stub": "vendored" } },
			{ files: { "src/a.stub": "alpha" } },
		);
	});

	test("a file that grew past the size limit is retired, with evidence", async () => {
		const before: ProjectState = {
			files: { "src/a.stub": "alpha", "src/big.stub": "beta" },
			config: { maxFileSizeBytes: 1_000 },
		};
		const after: ProjectState = {
			files: { "src/a.stub": "alpha", "src/big.stub": "beta" },
			config: { maxFileSizeBytes: 3 },
		};
		await expectConverges(before, after);

		const reused = await reusedIndex(before, after);
		const big = reused.files.find((f) => f.path === "src/big.stub");
		expect(big?.nodeCount).toBe(0);
		expect(big?.errors.map((e) => e.code)).toEqual(["FILE_TOO_LARGE"]);
	});

	test("disabling a backend removes its rows, not just its future work", async () => {
		await expectConverges(
			{ files: { "src/a.stub": "alpha", "src/b.other": "beta" } },
			{
				files: { "src/a.stub": "alpha", "src/b.other": "beta" },
				backends: [STUB],
			},
		);
	});

	test("enabling a backend adds its rows", async () => {
		await expectConverges(
			{
				files: { "src/a.stub": "alpha", "src/b.other": "beta" },
				backends: [STUB],
			},
			{ files: { "src/a.stub": "alpha", "src/b.other": "beta" } },
		);
	});

	test("a file whose extension lost its backend keeps only its evidence", async () => {
		const after: ProjectState = {
			files: { "src/a.stub": "alpha", "src/b.other": "beta" },
			backends: [STUB],
		};
		const reused = await reusedIndex(
			{ files: { "src/a.stub": "alpha", "src/b.other": "beta" } },
			after,
		);

		expect(reused.nodes.map((n) => n.filePath)).toEqual(["src/a.stub"]);
		const orphan = reused.files.find((f) => f.path === "src/b.other");
		expect(orphan?.errors.map((e) => e.code)).toEqual(["NO_BACKEND"]);
	});
});

describe("an interrupted pass is detectable", () => {
	test("a completed index reports no interruption", async () => {
		const storage = freshStorage();
		const { indexer, queries } = openIndexer(
			{ files: { "src/a.stub": "alpha" } },
			storage,
		);
		try {
			await indexer.indexAll();
			expect(indexer.lastPassInterrupted()).toBe(false);
			expect(queries.getStats().indexInterrupted).toBeUndefined();
		} finally {
			storage.close();
		}
	});

	test("a pass that throws leaves the index marked interrupted", async () => {
		const storage = freshStorage();
		const queries = new QueryBuilder(storage);
		const exploding: LanguageBackend = {
			...STUB,
			parser: {
				extractNodes(): PassAResult {
					throw new Error("backend exploded mid-pass");
				},
			},
		};

		const indexer = new Indexer({
			queries,
			storage,
			fs: memoryFs({ "/project/src/a.stub": "alpha" }),
			hasher: HASHER,
			glob: memoryGlob(["src/a.stub"]),
			registry: new LanguageRegistry([exploding]),
			root: "/project",
			now: () => NOW,
		});

		try {
			await expect(indexer.indexAll()).rejects.toThrow("backend exploded");

			// The identity was never advanced, and the mixture is visible.
			expect(indexer.lastPassInterrupted()).toBe(true);
			expect(queries.getStats().indexInterrupted).toBe(true);
		} finally {
			storage.close();
		}
	});

	test("the next successful pass clears the interruption", async () => {
		const storage = freshStorage();
		const state: ProjectState = { files: { "src/a.stub": "alpha" } };
		const { indexer, queries } = openIndexer(state, storage);
		try {
			// Simulate a crashed predecessor.
			storage
				.prepare(
					"INSERT INTO project_metadata (key, value, updated_at) VALUES ('passState', 'in_progress', 0)",
				)
				.run();
			expect(indexer.lastPassInterrupted()).toBe(true);

			await indexer.indexAll();

			expect(indexer.lastPassInterrupted()).toBe(false);
			expect(queries.getStats().indexInterrupted).toBeUndefined();
			expect(normalizeIndex(queries)).toEqual(await cleanIndex(state));
		} finally {
			storage.close();
		}
	});
});

/* -------------------------------------------------------------------------- */
/* AG-205: full, scanner sync and event sync are one model                     */
/* -------------------------------------------------------------------------- */

/** Index `before`, then reach `after` through `sync()`. */
async function scannerSync(before: ProjectState, after: ProjectState) {
	const storage = freshStorage();
	try {
		const first = openIndexer(before, storage);
		await first.indexer.indexAll();

		const second = openIndexer(after, storage);
		await second.indexer.sync();
		return normalizeIndex(second.queries);
	} finally {
		storage.close();
	}
}

/** Index `before`, then reach `after` through `syncFiles()` with a watch batch. */
async function eventSync(
	before: ProjectState,
	after: ProjectState,
	events: WatchEvent[],
) {
	const storage = freshStorage();
	try {
		const first = openIndexer(before, storage);
		await first.indexer.indexAll();

		const second = openIndexer(after, storage);
		await second.indexer.syncFiles(events);
		return normalizeIndex(second.queries);
	} finally {
		storage.close();
	}
}

/** The events a watcher would emit for `before -> after`. */
function eventsFor(before: ProjectState, after: ProjectState): WatchEvent[] {
	const events: WatchEvent[] = [];
	for (const path of Object.keys(after.files)) {
		if (!(path in before.files)) events.push({ type: "add", path });
		else if (before.files[path] !== after.files[path]) {
			events.push({ type: "change", path });
		}
	}
	for (const path of Object.keys(before.files)) {
		if (!(path in after.files)) events.push({ type: "unlink", path });
	}
	return events;
}

async function expectAllFourAgree(before: ProjectState, after: ProjectState) {
	const expected = await cleanIndex(after);
	expect(await reusedIndex(before, after)).toEqual(expected);
	expect(await scannerSync(before, after)).toEqual(expected);
	expect(await eventSync(before, after, eventsFor(before, after))).toEqual(
		expected,
	);
}

describe("full, scanner sync and event sync converge (ADR-004)", () => {
	test("add", async () => {
		await expectAllFourAgree(
			{ files: { "src/a.stub": "alpha" } },
			{ files: { "src/a.stub": "alpha", "src/b.stub": "beta" } },
		);
	});

	test("modify", async () => {
		await expectAllFourAgree(
			{ files: { "src/a.stub": "alpha beta" } },
			{ files: { "src/a.stub": "alpha gamma" } },
		);
	});

	test("remove", async () => {
		await expectAllFourAgree(
			{ files: { "src/a.stub": "alpha", "src/b.stub": "beta" } },
			{ files: { "src/a.stub": "alpha" } },
		);
	});

	test("rename is remove plus add", async () => {
		await expectAllFourAgree(
			{ files: { "src/old.stub": "alpha" } },
			{ files: { "src/new.stub": "alpha" } },
		);
	});

	test("a size-limit change", async () => {
		await expectAllFourAgree(
			{
				files: { "src/a.stub": "alpha", "src/big.stub": "beta" },
				config: { maxFileSizeBytes: 1_000 },
			},
			{
				files: { "src/a.stub": "alpha", "src/big.stub": "beta" },
				config: { maxFileSizeBytes: 3 },
			},
		);
	});
});

describe("event coalescing is deterministic", () => {
	test("unlink dominates a change for the same path", async () => {
		const before: ProjectState = {
			files: { "src/a.stub": "alpha", "src/doomed.stub": "beta" },
		};
		const after: ProjectState = { files: { "src/a.stub": "alpha" } };

		// A watcher may report the write and the delete in either order.
		const forward: WatchEvent[] = [
			{ type: "change", path: "src/doomed.stub" },
			{ type: "unlink", path: "src/doomed.stub" },
		];
		const backward: WatchEvent[] = [...forward].reverse();

		const expected = await cleanIndex(after);
		expect(await eventSync(before, after, forward)).toEqual(expected);
		expect(await eventSync(before, after, backward)).toEqual(expected);
	});

	test("an event batch does not retire files it never mentioned", async () => {
		// A watch batch speaks only about its own paths; treating silence as
		// deletion would empty the graph on the first single-file save.
		const storage = freshStorage();
		try {
			const state: ProjectState = {
				files: { "src/a.stub": "alpha", "src/b.stub": "beta" },
			};
			const first = openIndexer(state, storage);
			await first.indexer.indexAll();

			const changed: ProjectState = {
				files: { "src/a.stub": "alpha gamma", "src/b.stub": "beta" },
			};
			const second = openIndexer(changed, storage);
			const result = await second.indexer.syncFiles([
				{ type: "change", path: "src/a.stub" },
			]);

			expect(result.removed).toEqual([]);
			expect(second.queries.getNodesByFile("src/b.stub").length).toBe(1);
		} finally {
			storage.close();
		}
	});

	test("syncFiles refreshes the identity like sync does", async () => {
		const storage = freshStorage();
		try {
			const state: ProjectState = { files: { "src/a.stub": "alpha" } };
			const { indexer, queries } = openIndexer(state, storage);
			await indexer.indexAll();

			const before = queries.getStats().lastUpdated;
			await indexer.syncFiles([{ type: "change", path: "src/a.stub" }]);

			// A watch-driven index that never refreshed its metadata was a second
			// kind of index; both paths must leave the same identity behind.
			expect(indexer.lastPassInterrupted()).toBe(false);
			expect(queries.getStats().lastUpdated).toEqual(before);
		} finally {
			storage.close();
		}
	});
});
