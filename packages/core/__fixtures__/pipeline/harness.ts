import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { OpenProjectDependencies } from "../../src/adapters/bun/project";
import { openProjectWithDependencies } from "../../src/adapters/bun/project";
import { BunSqliteStorageAdapter } from "../../src/adapters/bun/sqlite";
import type { Astrograph } from "../../src/astrograph";
import type { AstrographConfig, BackendConfig } from "../../src/config";
import { SHIPPED_BACKEND_IDS } from "../../src/config";
import {
	type NormalizedEnvelope,
	type NormalizedIndex,
	normalizeEnvelope,
	normalizeIndex,
} from "../../src/testing/normalize";
import type { ToolResult, WatchEvent } from "../../src/types";
import { AstrographError } from "../../src/types";

/**
 * AG-302: the deterministic production-pipeline harness.
 *
 * ## Why this exists next to `../harness.ts`
 *
 * The extractor harness calls `TsExtractor` directly. That proves what the
 * extractor computes and nothing about what the product persists: registry
 * routing, Indexer phase order, SQLite retirement and the query envelope are
 * all downstream of it (`DEV-014`). This harness runs the *real* composition
 * root — `openProject` — over a temporary project, so a fixture failure is a
 * statement about the shipped pipeline.
 *
 * ## What is pinned, and why each one has to be
 *
 * | Pinned | Why an unpinned value would break the oracle |
 * |---|---|
 * | Clock (`PIPELINE_PINNED_NOW`) | `updatedAt`/`indexedAt` are dropped by the oracle, but the *config hash* and freshness metadata are not. |
 * | Type environment ({@link HERMETIC_TSCONFIG}) | Without it the TypeScript program resolves `@types` from the *process* working directory — this repository — so a fixture silently borrows whatever is installed here. |
 * | Project root | A fresh `mkdtemp` per run; the oracle strips it, and nothing outside it is read. |
 * | Project name | `openProject` fixes it to `root`, which node ids hash. |
 * | Configuration | Declared per fixture, never inherited from the repository. |
 * | Database | One file per session under the temporary root, deleted with it. |
 *
 * The project root deliberately lives outside the repository: a fixture rooted
 * in `packages/core` would discover the repository `tsconfig.json`, and the
 * goldens would then encode this checkout's compiler options.
 *
 * ## What is *not* faked
 *
 * The filesystem, the glob scanner, SQLite, tree-sitter, the TypeScript program
 * and both shipped backends are the production ones. The only seams a fixture
 * may reach for are `createRegistry` and `loadGrammars` on
 * `OpenProjectDependencies` — adapter-local, absent from every barrel, and used
 * by AG-306 alone to inject failures that have no other trigger.
 */

/** Fixed clock. Shared with the extractor harness so both agree on identity. */
export const PIPELINE_PINNED_NOW = 1_700_000_000_000;

/** Directory holding the pipeline fixtures, their manifests and their goldens. */
export const PIPELINE_ROOT = import.meta.dir;

/**
 * The `tsconfig.json` every JS/TS fixture gets unless it supplies its own.
 *
 * Without this the harness is **not hermetic**, and the way it leaks is not
 * obvious. `ts.createProgram` has no `types`/`typeRoots` set, so TypeScript
 * falls back to automatic `@types` discovery — and it resolves those from
 * `ts.sys.getCurrentDirectory()`, the process working directory, not from the
 * project root it was handed. Running the suite from this repository therefore
 * pulled `bun-types` and `@types/bun` into every fixture's program, and with
 * them the ambient Node declarations.
 *
 * The observable damage was a *wrong answer that looked right*: `import { join }
 * from "node:path"` in a project with no dependencies came back
 * `external`/`high` — "the declaration is known, it just is not yours" — when
 * the honest answer is `unresolved`/`low`. A fixture asserting that an
 * unprovable target stays unproven was passing because the harness had quietly
 * made the target provable, and the recorded goldens encoded whichever type
 * packages this checkout happened to have installed.
 *
 * `types: []` and `typeRoots: []` switch automatic discovery off. Real module
 * resolution is untouched, so a package genuinely installed inside the fixture's
 * own root still resolves — see `JSTS_EXTERNAL_PACKAGE_MANIFEST`.
 */
export const HERMETIC_TSCONFIG = `${JSON.stringify(
	{
		compilerOptions: {
			target: "esnext",
			module: "esnext",
			moduleResolution: "bundler",
			jsx: "preserve",
			allowJs: true,
			checkJs: false,
			skipLibCheck: true,
			// The whole point: no ambient types from outside this root.
			types: [],
			typeRoots: [],
		},
	},
	null,
	2,
)}\n`;

export type ShippedBackendId = (typeof SHIPPED_BACKEND_IDS)[number];

/**
 * How a backend is configured for one fixture run.
 *
 * `pass-a-only` is `backends.<id>.enricher = false`: tree-sitter Pass A runs and
 * the backend advertises only `contains`. `disabled` is
 * `backends.<id>.enabled = false`, which removes the backend from the registry
 * entirely — its extensions then look unowned, which is a different and
 * deliberately visible outcome.
 */
export type BackendMode = "enriched" | "pass-a-only" | "disabled";

export type BackendModes = Partial<Record<ShippedBackendId, BackendMode>>;

/** A file the fixture writes into the temporary project root. */
export type FixtureFiles = Record<string, string>;

/**
 * One named question asked of the production query surface.
 *
 * The name is the key its envelope gets in the snapshot, so it must stay stable
 * across golden updates. A probe returns the whole `ToolResult` and the harness
 * keeps only the normalized envelope: payload shape belongs to the query unit
 * tests, while what the *answer claimed about its own completeness* is what a
 * pipeline fixture is for.
 */
export interface QueryProbe {
	name: string;
	run(graph: Astrograph): Promise<ToolResult<unknown>>;
}

export interface PipelineManifest {
	/** Stable identifier; also the golden directory under `PIPELINE_ROOT`. */
	id: string;
	/** One-line statement of what this fixture is evidence for. */
	description: string;
	/** Project-relative path → content. Written verbatim into the temp root. */
	files: FixtureFiles;
	/**
	 * Set false to leave the temporary root without a `tsconfig.json`.
	 *
	 * Only a fixture that is *about* configuration discovery should do this, and
	 * it then inherits the process working directory's `@types`, which is not
	 * reproducible. Nothing in the suite sets it today.
	 */
	hermeticTsconfig?: boolean;
	/** Per-backend mode. A backend left out keeps its shipped default. */
	modes?: BackendModes;
	/** Everything else about the configuration, e.g. `maxFileSizeBytes`. */
	config?: Omit<AstrographConfig, "backends">;
	/** Questions whose envelopes this fixture pins. */
	probes?: QueryProbe[];
	/**
	 * How this fixture reaches the state its golden describes. Defaults to one
	 * clean full index.
	 *
	 * A few conditions are only reachable through a sequence — a file record that
	 * survives its backend being disabled exists precisely because an earlier
	 * pass indexed it (AG-306). Putting that sequence in the manifest keeps the
	 * golden reproducible: the updater and the test run the identical steps.
	 */
	run?(session: PipelineSession): Promise<void>;
	/**
	 * AG-306 only: composition-step overrides. Left undefined by every fixture
	 * that has a real trigger for what it wants to prove.
	 */
	injection?: PipelineInjection;
}

export type PipelineInjection = Omit<
	OpenProjectDependencies,
	"createStorage"
> & {
	createStorage?: OpenProjectDependencies["createStorage"];
};

/**
 * A probe's outcome.
 *
 * A refusal is an outcome, not a hole in the snapshot. `callers` on a symbol
 * that no longer exists throws `NOT_FOUND`, and a fixture whose target was
 * deleted needs to record exactly that — otherwise the probe could only be
 * asked of states where it happens to succeed, which is the opposite of what a
 * mutation matrix is for. Only the structured code is kept; the message is
 * prose and would make the golden fail on a copy-edit.
 */
export type ProbeOutcome = NormalizedEnvelope | { errorCode: string };

/** A fixture's two independent snapshots (AG-301). */
export interface PipelineSnapshot {
	/** Persisted truth: files, nodes, edges, states, diagnostics. */
	graph: NormalizedIndex;
	/** What each probe claimed about its own completeness, or why it refused. */
	envelopes: Record<string, ProbeOutcome>;
}

/** A filesystem or configuration change, applied between routes (AG-307). */
export type FixtureMutation =
	| { write: string; content: string }
	| { delete: string };

/** Configuration the session can be reopened with. */
export interface ReopenOptions {
	modes?: BackendModes;
	config?: Omit<AstrographConfig, "backends">;
	injection?: PipelineInjection;
}

/**
 * One temporary project, its database, and the currently open facade.
 *
 * A session owns its root directory and its SQLite file; `close()` releases
 * both. `reopen()` closes the facade and composes a new one over the *same*
 * database, which is how a reused-index or configuration-change route is built.
 */
export class PipelineSession {
	readonly root: string;
	readonly dbPath: string;

	private graph: Astrograph;
	private modes: BackendModes;
	private baseConfig: Omit<AstrographConfig, "backends">;
	private injection: PipelineInjection | undefined;
	private closed = false;

	private constructor(options: {
		root: string;
		dbPath: string;
		graph: Astrograph;
		modes: BackendModes;
		baseConfig: Omit<AstrographConfig, "backends">;
		injection: PipelineInjection | undefined;
	}) {
		this.root = options.root;
		this.dbPath = options.dbPath;
		this.graph = options.graph;
		this.modes = options.modes;
		this.baseConfig = options.baseConfig;
		this.injection = options.injection;
	}

	/**
	 * Materialize a project and open it.
	 *
	 * Every failure after the directory exists removes it again: an initialization
	 * error must not leave a temp tree behind, and a caller that never received a
	 * session cannot close one.
	 */
	static async open(manifest: PipelineManifest): Promise<PipelineSession> {
		const root = await mkdtemp(`${tmpdir()}/astrograph-pipeline-`);
		try {
			// A fixture that ships its own tsconfig keeps it; that is real project
			// content and overriding it would defeat the point of supplying one.
			const files: FixtureFiles =
				manifest.hermeticTsconfig === false || "tsconfig.json" in manifest.files
					? manifest.files
					: { ...manifest.files, "tsconfig.json": HERMETIC_TSCONFIG };
			await writeProjectFiles(root, files);
			const dbPath = `${root}/.astrograph/pipeline.db`;
			const modes = manifest.modes ?? {};
			const baseConfig = manifest.config ?? {};
			const graph = await openPipelineProject({
				root,
				dbPath,
				modes,
				baseConfig,
				injection: manifest.injection,
			});
			return new PipelineSession({
				root,
				dbPath,
				graph,
				modes,
				baseConfig,
				injection: manifest.injection,
			});
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	/** The production facade. Use it exactly as a CLI or MCP caller would. */
	get astrograph(): Astrograph {
		if (this.closed) throw new Error("pipeline session is closed");
		return this.graph;
	}

	indexAll(): Promise<void> {
		return this.astrograph.indexAll();
	}

	sync(): Promise<{ added: string[]; modified: string[]; removed: string[] }> {
		return this.astrograph.sync();
	}

	syncFiles(
		events: WatchEvent[],
	): Promise<{ added: string[]; modified: string[]; removed: string[] }> {
		return this.astrograph.syncFiles(events);
	}

	/** Apply filesystem mutations in the order given. */
	async mutate(mutations: readonly FixtureMutation[]): Promise<void> {
		for (const mutation of mutations) {
			if ("delete" in mutation) {
				await rm(`${this.root}/${mutation.delete}`, { force: true });
				continue;
			}
			await writeProjectFile(this.root, mutation.write, mutation.content);
		}
	}

	/**
	 * Close the facade and compose a new one over the same database.
	 *
	 * This is the only honest way to change configuration: the registry, the
	 * config hash and the scanner's extension list are all decided at
	 * composition time, exactly as they are when a user edits their config file
	 * and runs the CLI again.
	 */
	async reopen(options: ReopenOptions = {}): Promise<void> {
		if (this.closed) throw new Error("pipeline session is closed");
		this.graph.close();
		if (options.modes !== undefined) this.modes = options.modes;
		if (options.config !== undefined) this.baseConfig = options.config;
		if (options.injection !== undefined) this.injection = options.injection;
		this.graph = await openPipelineProject({
			root: this.root,
			dbPath: this.dbPath,
			modes: this.modes,
			baseConfig: this.baseConfig,
			injection: this.injection,
		});
	}

	/** Persisted graph truth, normalized through the AG-301 oracle. */
	snapshotGraph(): NormalizedIndex {
		return normalizeIndex(this.astrograph.queries, { rootPath: this.root });
	}

	/** Each probe's envelope, keyed by probe name. */
	async snapshotEnvelopes(
		probes: readonly QueryProbe[] = [],
	): Promise<Record<string, ProbeOutcome>> {
		const envelopes: Record<string, ProbeOutcome> = {};
		for (const probe of [...probes].sort((a, b) =>
			compareStrings(a.name, b.name),
		)) {
			if (probe.name in envelopes) {
				throw new Error(`duplicate probe name "${probe.name}"`);
			}
			envelopes[probe.name] = await this.probeOutcome(probe);
		}
		return envelopes;
	}

	private async probeOutcome(probe: QueryProbe): Promise<ProbeOutcome> {
		try {
			const result = await probe.run(this.astrograph);
			return normalizeEnvelope(result.meta, { rootPath: this.root });
		} catch (error) {
			// Only a structured tool refusal is an outcome. Anything else is a
			// defect in the harness or the pipeline and must not be swallowed into
			// a golden that then looks stable.
			if (error instanceof AstrographError) return { errorCode: error.code };
			throw error;
		}
	}

	/** Both snapshots, taken from the same open database. */
	async snapshot(
		probes: readonly QueryProbe[] = [],
	): Promise<PipelineSnapshot> {
		return {
			graph: this.snapshotGraph(),
			envelopes: await this.snapshotEnvelopes(probes),
		};
	}

	/**
	 * Release the facade, the SQLite handle and the temporary tree.
	 *
	 * Idempotent, and the directory is removed even when closing the facade
	 * throws: a leaked temp tree is invisible until CI runs out of inodes.
	 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			this.graph.close();
		} finally {
			await rm(this.root, { recursive: true, force: true });
		}
	}
}

/**
 * Open a session, hand it to `body`, and close it whatever happens.
 *
 * Prefer this over `PipelineSession.open` in tests: `bun test` reports the
 * assertion failure, and the temporary root is gone either way.
 */
export async function withPipeline<T>(
	manifest: PipelineManifest,
	body: (session: PipelineSession) => Promise<T>,
): Promise<T> {
	const session = await PipelineSession.open(manifest);
	try {
		return await body(session);
	} finally {
		await session.close();
	}
}

/**
 * The common case: clean full index, then both snapshots.
 *
 * This is what a golden fixture records, and what every route in AG-307 is
 * compared against.
 */
export async function runCleanPipeline(
	manifest: PipelineManifest,
): Promise<PipelineSnapshot> {
	return withPipeline(manifest, async (session) => {
		await (manifest.run ?? ((target) => target.indexAll()))(session);
		return session.snapshot(manifest.probes ?? []);
	});
}

/** The configuration a manifest's modes and base config add up to. */
export function pipelineConfig(
	modes: BackendModes,
	baseConfig: Omit<AstrographConfig, "backends"> = {},
): AstrographConfig {
	const backends: Record<string, BackendConfig> = {};
	for (const id of SHIPPED_BACKEND_IDS) {
		const mode = modes[id];
		if (mode === undefined) continue;
		backends[id] =
			mode === "disabled"
				? { enabled: false }
				: { enabled: true, enricher: mode === "enriched" };
	}
	return Object.keys(backends).length === 0
		? { ...baseConfig }
		: { ...baseConfig, backends };
}

/**
 * Everything `openProject` needs for one composition of a fixture project.
 *
 * These five travel together through `open`, `reopen` and the composer, which
 * is what makes them one thing rather than five parameters: a reopen is exactly
 * "the same composition with some of these replaced".
 */
interface PipelineComposition {
	root: string;
	dbPath: string;
	modes: BackendModes;
	baseConfig: Omit<AstrographConfig, "backends">;
	injection: PipelineInjection | undefined;
}

async function openPipelineProject(
	options: PipelineComposition,
): Promise<Astrograph> {
	return openProjectWithDependencies(
		options.root,
		{
			config: pipelineConfig(options.modes, options.baseConfig),
			now: () => PIPELINE_PINNED_NOW,
			dbPath: options.dbPath,
		},
		{
			createStorage: (path) => new BunSqliteStorageAdapter(path),
			...(options.injection ?? {}),
		},
	);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

async function writeProjectFiles(
	root: string,
	files: FixtureFiles,
): Promise<void> {
	for (const relPath of Object.keys(files).sort()) {
		await writeProjectFile(root, relPath, files[relPath] ?? "");
	}
}

async function writeProjectFile(
	root: string,
	relPath: string,
	content: string,
): Promise<void> {
	const absolute = `${root}/${relPath}`;
	const parent = absolute.slice(0, absolute.lastIndexOf("/"));
	await mkdir(parent, { recursive: true });
	await Bun.write(absolute, content);
}

/**
 * Read a fixture source tree from the repository into a `files` map.
 *
 * Used by fixtures whose inputs are worth reviewing as real, highlighted source
 * files rather than as string literals. `__golden__` is skipped: the expected
 * artifacts are not part of the project under test.
 */
export async function readFixtureTree(
	dirRelativeToPipelineRoot: string,
	options: { into?: string } = {},
): Promise<FixtureFiles> {
	const base = `${PIPELINE_ROOT}/${dirRelativeToPipelineRoot}`;
	const prefix = options.into === undefined ? "" : `${options.into}/`;
	const files: FixtureFiles = {};

	const walk = async (dir: string, relative: string): Promise<void> => {
		for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
			(a, b) => compareStrings(a.name, b.name),
		)) {
			if (entry.name === "__golden__") continue;
			const childRelative =
				relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				await walk(`${dir}/${entry.name}`, childRelative);
				continue;
			}
			files[`${prefix}${childRelative}`] = await Bun.file(
				`${dir}/${entry.name}`,
			).text();
		}
	};

	await walk(base, "");
	return files;
}
