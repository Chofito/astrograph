import { describe, expect, test } from "bun:test";
import { BunSqliteStorageAdapter } from "./adapters/bun/sqlite";
import { runMigrations } from "./db/migrations";
import { QueryBuilder } from "./db/queries";
import { LanguageRegistry } from "./extraction/registry";
import { Indexer } from "./indexer";
import { type NormalizedIndex, normalizeIndex } from "./testing/normalize";
import type { AstrographConfig } from "./config";
import type {
	Edge,
	EdgeResolutionResult,
	FileSystem,
	GlobScanner,
	Hasher,
	LanguageBackend,
	Node,
	NodeKind,
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

/**
 * One node per token. A bare word declares a symbol; `->name` references one.
 *
 * Reference nodes exist so the stub enricher can resolve cross-file relations
 * from *persisted Pass A state*, the way PHP does, rather than needing the
 * source text `resolveEdges(filePath)` does not receive.
 */
function node(
	filePath: string,
	name: string,
	language: string,
	kind: NodeKind = "function",
): Node {
	return {
		id: `${filePath}::${kind}:${name}`,
		project: "root",
		kind,
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

const REFERENCE_PREFIX = "->";

function declarations(source: string): string[] {
	return source
		.split(/\s+/)
		.filter((w) => w.length > 0 && !w.startsWith(REFERENCE_PREFIX));
}

function references(source: string): string[] {
	return source
		.split(/\s+/)
		.filter((w) => w.startsWith(REFERENCE_PREFIX))
		.map((w) => w.slice(REFERENCE_PREFIX.length))
		.filter((w) => w.length > 0);
}

/**
 * A miniature language backend that produces real cross-file relations.
 *
 * A retirement bug is invisible to a backend that emits no edges, so this one
 * resolves `->name` references against the project's persisted declarations —
 * within its own language only, and from its own project state, exactly as a
 * real backend must.
 */
function backend(id: string, extensions: string[]): LanguageBackend {
	let fileNames: string[] = [];
	let loadNodesForFile: (filePath: string) => Node[] = () => [];

	const owns = (filePath: string) =>
		extensions.some((ext) => filePath.toLowerCase().endsWith(ext));

	return {
		id,
		languages: [id],
		extensions,
		parser: {
			extractNodes(filePath: string, source: string): PassAResult {
				return {
					nodes: [
						...declarations(source).map((name) => node(filePath, name, id)),
						...references(source).map((name) =>
							node(filePath, name, id, "import"),
						),
					],
					edges: [],
					errors: [],
				};
			},
		},
		enricher: {
			mode: "complement",
			id: `${id}-enricher`,
			provenance: "synthesized:stub",
			loadProject(opts) {
				fileNames = [...(opts.fileNames ?? [])];
				loadNodesForFile = opts.loadNodesForFile ?? (() => []);
			},
			resolveEdges(filePath: string): EdgeResolutionResult {
				// Declarations visible to this backend, from persisted Pass A rows.
				const declarationsByName = new Map<string, Node>();
				for (const candidate of fileNames) {
					for (const persisted of loadNodesForFile(candidate)) {
						if (persisted.kind !== "function") continue;
						if (!declarationsByName.has(persisted.name)) {
							declarationsByName.set(persisted.name, persisted);
						}
					}
				}

				const edges: Edge[] = [];
				for (const reference of loadNodesForFile(filePath)) {
					if (reference.kind !== "import") continue;
					const target = declarationsByName.get(reference.name);
					edges.push({
						source: reference.id,
						target: target?.id ?? null,
						targetName: reference.name,
						kind: "calls",
						resolutionState: target === undefined ? "unresolved" : "resolved",
						confidence: target === undefined ? "low" : "high",
						provenance: "synthesized:stub",
					});
				}
				return { edges, errors: [], externalNodes: [] };
			},
			invalidate(input) {
				// Membership changes move declarations in and out of view, so the
				// whole owned set is re-resolved; content edits use recorded edges.
				if (
					input.added.length > 0 ||
					input.removed.length > 0 ||
					input.configurationChanged
				) {
					return { resolveFiles: input.ownedFiles.filter(owns).sort() };
				}
				const affected = new Set<string>();
				for (const filePath of input.modified) {
					affected.add(filePath);
					for (const dependent of input.dependentsOf(filePath)) {
						affected.add(dependent);
					}
				}
				for (const identity of input.priorIdentities) {
					if (!owns(identity.filePath)) continue;
					for (const dependent of input.dependentsOf(identity.filePath)) {
						affected.add(dependent);
					}
				}
				return { resolveFiles: [...affected].filter(owns).sort() };
			},
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

/* -------------------------------------------------------------------------- */
/* AG-209: crossing the eligibility boundary, with real incoming relations     */
/* -------------------------------------------------------------------------- */

/**
 * `src/caller.stub` calls `target`, declared in `src/target.stub`. Every test
 * below moves `src/target.stub` across the eligibility boundary and checks that
 * the incoming relation is demoted rather than deleted, and that all four
 * routes agree.
 */
const LINKED_PROJECT: Record<string, string> = {
	// 15 bytes. Stays eligible under the tight limit below.
	"src/caller.stub": "caller ->target",
	// 25 bytes. The padding exists so a size limit can single this file out;
	// with the caller as the larger file the tests would retire the wrong end of
	// the relation and prove nothing.
	"src/target.stub": "target padpadpadpadpadpad",
};

/** Between the two file sizes above: the target is out, the caller is in. */
const TIGHT_LIMIT = 20;
const LOOSE_LIMIT = 1_000;

function edgesTo(index: NormalizedIndex, targetName: string) {
	return index.edges.filter((edge) => edge.targetName === targetName);
}

describe("crossing the eligibility boundary converges on every route", () => {
	test("the fixture really does record an incoming relation", async () => {
		// Guard on the guard: a backend that emits no edges cannot demonstrate
		// anything about retirement.
		const clean = await cleanIndex({ files: LINKED_PROJECT });
		const resolved = edgesTo(clean, "target");
		expect(resolved.length).toBe(1);
		expect(resolved[0]?.resolutionState).toBe("resolved");
		expect(resolved[0]?.target).not.toBeNull();
	});

	test("a file that grows past the size limit", async () => {
		const before: ProjectState = {
			files: LINKED_PROJECT,
			config: { maxFileSizeBytes: LOOSE_LIMIT },
		};
		const after: ProjectState = {
			files: LINKED_PROJECT,
			config: { maxFileSizeBytes: TIGHT_LIMIT },
		};
		await expectAllFourAgree(before, after);

		const reused = await reusedIndex(before, after);
		const demoted = edgesTo(reused, "target");
		expect(demoted.length).toBe(1);
		expect(demoted[0]?.resolutionState).toBe("unresolved");
		expect(demoted[0]?.target).toBeNull();
	});

	test("a file that leaves the scan scope", async () => {
		await expectAllFourAgree(
			{ files: LINKED_PROJECT },
			{ files: { "src/caller.stub": "caller ->target" } },
		);
	});

	test("a backend that gets disabled", async () => {
		// The `.stub` reference never resolved into `.other` in the first place —
		// a backend may only resolve within its own language — so what this
		// asserts is that disabling a backend retires its rows and that all four
		// routes agree afterwards, including the evidence record left behind.
		const acrossBackends: Record<string, string> = {
			"src/caller.stub": "caller ->target",
			"src/target.other": "target",
		};
		await expectAllFourAgree(
			{ files: acrossBackends },
			{ files: acrossBackends, backends: [STUB] },
		);

		const reused = await reusedIndex(
			{ files: acrossBackends },
			{ files: acrossBackends, backends: [STUB] },
		);
		expect(reused.nodes.some((n) => n.filePath === "src/target.other")).toBe(
			false,
		);
	});

	test("a file that becomes eligible again", async () => {
		const tight: ProjectState = {
			files: LINKED_PROJECT,
			config: { maxFileSizeBytes: TIGHT_LIMIT },
		};
		const loose: ProjectState = {
			files: LINKED_PROJECT,
			config: { maxFileSizeBytes: LOOSE_LIMIT },
		};
		await expectAllFourAgree(tight, loose);

		const restored = await reusedIndex(tight, loose);
		const resolved = edgesTo(restored, "target");
		expect(resolved[0]?.resolutionState).toBe("resolved");
	});
});

describe("an event batch retires a candidate that lost eligibility", () => {
	test("a change event on a now-oversized file demotes its incoming relations", async () => {
		// The reported bug: `syncFiles` named the file as a candidate, `runPass`
		// skipped it because it was ineligible, and `recordIneligibleFile` then
		// deleted its rows directly — dropping the incoming edge instead of
		// demoting it.
		const storage = freshStorage();
		try {
			const first = openIndexer(
				{ files: LINKED_PROJECT, config: { maxFileSizeBytes: LOOSE_LIMIT } },
				storage,
			);
			await first.indexer.indexAll();
			expect(
				first.queries
					.getAllEdges()
					.filter((edge) => edge.resolutionState === "resolved").length,
			).toBeGreaterThan(0);

			const second = openIndexer(
				{ files: LINKED_PROJECT, config: { maxFileSizeBytes: TIGHT_LIMIT } },
				storage,
			);
			const result = await second.indexer.syncFiles([
				{ type: "change", path: "src/target.stub" },
			]);

			expect(result.removed).toEqual(["src/target.stub"]);

			const demoted = second.queries
				.getAllEdges()
				.filter((edge) => edge.targetName === "target");
			expect(demoted.length).toBe(1);
			expect(demoted[0]?.resolutionState).toBe("unresolved");
			expect(demoted[0]?.target).toBeNull();

			// The evidence record survives, and the file keeps no nodes.
			const record = second.queries.getFile("src/target.stub");
			expect(record?.nodeCount).toBe(0);
			expect((record?.errors ?? []).map((e) => e.code)).toEqual([
				"FILE_TOO_LARGE",
			]);
			expect(second.queries.getDanglingEdges()).toEqual([]);
		} finally {
			storage.close();
		}
	});

	test("an unmentioned ineligible file is still left alone", async () => {
		// The `eventScoped` guard must keep protecting silence: a batch about one
		// file may not retire another that merely happens to be ineligible.
		const storage = freshStorage();
		try {
			const files: Record<string, string> = {
				...LINKED_PROJECT,
				"notes.txt": "unclaimed",
			};
			const first = openIndexer({ files }, storage);
			await first.indexer.indexAll();

			const second = openIndexer({ files }, storage);
			const result = await second.indexer.syncFiles([
				{ type: "change", path: "src/caller.stub" },
			]);

			expect(result.removed).toEqual([]);
			// Its evidence record is untouched, not rewritten on every save.
			expect(
				(second.queries.getFile("notes.txt")?.errors ?? []).map((e) => e.code),
			).toEqual(["NO_BACKEND"]);
		} finally {
			storage.close();
		}
	});
});

describe("retirement keeps a textual identity, never a node id", () => {
	test("an incoming edge without targetName gets the retired node's name", async () => {
		// A backend that invalidates nothing, so the referrer is not re-resolved
		// and its edges are not rewritten. That isolates what is under test: the
		// value retirement itself writes into `targetName`. With the normal
		// backend the enricher would replace the edge and prove nothing.
		const inert: LanguageBackend = {
			id: STUB.id,
			languages: STUB.languages,
			extensions: STUB.extensions,
			parser: STUB.parser,
			capabilities: STUB.capabilities,
			versionKeys: STUB.versionKeys,
			enricher: {
				mode: "complement",
				id: "inert-enricher",
				provenance: "synthesized:stub",
				loadProject: () => {},
				resolveEdges: () => ({ edges: [], errors: [], externalNodes: [] }),
				invalidate: () => ({ resolveFiles: [] }),
			},
		};

		const storage = freshStorage();
		try {
			const { indexer, queries } = openIndexer(
				{ files: LINKED_PROJECT, backends: [inert] },
				storage,
			);
			await indexer.indexAll();

			const targetNode = queries
				.getNodesByFile("src/target.stub")
				.find((n) => n.name === "target");
			const caller = queries
				.getNodesByFile("src/caller.stub")
				.find((n) => n.name === "caller");
			expect(targetNode).toBeDefined();
			expect(caller).toBeDefined();

			// An edge the extractor never gave a textual name to. Before the fix
			// retirement filled `targetName` from `edge.target` — a content hash.
			queries.upsertEdge({
				source: caller?.id ?? "",
				target: targetNode?.id ?? "",
				kind: "references",
				resolutionState: "resolved",
				confidence: "high",
				provenance: "synthesized:stub",
			});

			const shrunk = openIndexer(
				{ files: { "src/caller.stub": LINKED_PROJECT["src/caller.stub"] ?? "" }, backends: [inert] },
				storage,
			);
			await shrunk.indexer.sync();

			const demoted = shrunk.queries
				.getAllEdges()
				.filter((edge) => edge.kind === "references");
			expect(demoted.length).toBe(1);
			expect(demoted[0]?.resolutionState).toBe("unresolved");
			expect(demoted[0]?.target).toBeNull();
			expect(demoted[0]?.targetName).toBe("src/target.stub::target");
			// Never the internal id.
			expect(demoted[0]?.targetName).not.toBe(targetNode?.id);
		} finally {
			storage.close();
		}
	});
});
