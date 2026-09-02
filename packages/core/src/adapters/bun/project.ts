import { mkdir } from "node:fs/promises";
import { Astrograph } from "../../astrograph";
import type { AstrographConfig } from "../../config";
import { runMigrations } from "../../db/migrations";
import { QueryBuilder } from "../../db/queries";
import {
	type CreateRegistryOptions,
	createDefaultRegistry,
	grammarsForRegistry,
	initTreeSitter,
	type LanguageRegistry,
	loadGrammars,
	shippedBackendExtensionOwners,
} from "../../extraction";
import { Indexer } from "../../indexer";
import { GraphQueries } from "../../query/graph-queries";
import type { StorageAdapter } from "../../types";
import { BunFileSystem } from "./fs";
import { BunGlobScanner } from "./glob";
import { BunHasher } from "./hasher";
import { BunSqliteStorageAdapter } from "./sqlite";

export interface OpenProjectOptions {
	config?: AstrographConfig;
	now?: () => number;
	dbPath?: string;
}

/**
 * Adapter-local seam for exercising ownership transfer during initialization
 * and, for AG-306, the failure modes that only exist between composition steps.
 * It is intentionally not exported from the Bun adapter barrel: a consumer that
 * could swap the registry or the grammar loader could also claim capabilities
 * the shipped backends do not have.
 *
 * Only `createStorage` is required. The other two default to exactly what
 * {@link openProject} does, so an override changes one composition step and
 * leaves the rest of the production path — Indexer phases, SQLite persistence,
 * `GraphQueries` — untouched.
 */
export interface OpenProjectDependencies {
	createStorage(path: string): StorageAdapter;
	/**
	 * Build the language registry. Overridden by pipeline fixtures that need a
	 * deterministically failing backend, or a backend whose extension has no
	 * tree-sitter grammar, without mutating the process-global grammar cache.
	 */
	createRegistry?(options: CreateRegistryOptions): LanguageRegistry;
	/** Load the grammars a registry needs. Overridden to skip WASM loading. */
	loadGrammars?(registry: LanguageRegistry): Promise<void>;
}

async function loadRegistryGrammars(registry: LanguageRegistry): Promise<void> {
	await initTreeSitter();
	await loadGrammars(grammarsForRegistry(registry));
}

/** Compose a Bun-backed project graph and initialize its storage and grammars. */
export async function openProject(
	rootPath: string,
	opts: OpenProjectOptions = {},
): Promise<Astrograph> {
	return openProjectWithDependencies(rootPath, opts, {
		createStorage: (path) => new BunSqliteStorageAdapter(path),
	});
}

/** @internal Adapter-local entry point used to observe initialization cleanup. */
export async function openProjectWithDependencies(
	rootPath: string,
	opts: OpenProjectOptions,
	dependencies: OpenProjectDependencies,
): Promise<Astrograph> {
	const root = normalizePath(rootPath);
	const astrographDir = `${root}/.astrograph`;
	await mkdir(astrographDir, { recursive: true });

	const storage = dependencies.createStorage(
		opts.dbPath ?? `${astrographDir}/graph.db`,
	);

	// Everything after the handle exists must hand ownership to `Astrograph` or
	// give the handle back. Migrations reject an index written by a newer build,
	// a registry can refuse an invalid backend, and a grammar can fail to load —
	// each of those used to leave the database file locked by a connection
	// nobody held a reference to, so the next open failed for the wrong reason.
	try {
		runMigrations(storage, { now: opts.now });

		const hasher = new BunHasher();
		const queries = new QueryBuilder(storage);
		const fs = new BunFileSystem();

		// One registry: it decides which files are scanned, which backend parses
		// each of them, and what `status` reports.
		const createRegistry =
			dependencies.createRegistry ??
			((options: CreateRegistryOptions) => createDefaultRegistry(options));
		const registry = createRegistry({
			hasher,
			now: opts.now,
			project: "root",
			config: opts.config,
		});

		await (dependencies.loadGrammars ?? loadRegistryGrammars)(registry);

		// Scanned: everything a *shipped* backend claims, enabled or not — not
		// just `registry.allExtensions()`, which omits a disabled backend's
		// extensions entirely.
		//
		// The difference is whether the product can tell the user "PHP is turned
		// off" or only stays silent. `classifyPath` already distinguishes
		// `backend_disabled` from `no_backend`, and `eligibilityEvidence` already
		// has the actionable message for it, but neither could ever fire: with
		// PHP disabled the scanner never yielded a `.php` path, so membership saw
		// a persisted path missing from the scan set and classified it
		// `out_of_scope` — which is deliberately not recordable. The rows were
		// deleted, and a project whose entire PHP half was unindexed answered
		// every query with `partial: false`, indistinguishable from a project
		// that simply has no PHP.
		//
		// Scanning is all that changes. A disabled backend's file is classified
		// ineligible, recorded as evidence with zero nodes, and never reaches a
		// parser or an enricher — contracts §13 still holds. The cost is one
		// evidence row per unindexed file, which is the price of the honest
		// answer.
		const glob = new BunGlobScanner({
			extensions: [
				...new Set([
					...registry.allExtensions(),
					...shippedBackendExtensionOwners().keys(),
				]),
			].sort(),
		});

		const indexer = new Indexer({
			queries,
			storage,
			fs,
			hasher,
			glob,
			registry,
			config: opts.config,
			root,
			now: opts.now,
		});
		const graphQueries = new GraphQueries({
			queries,
			fs,
			root,
			backends: registry.summary(),
		});

		// From here the returned object owns the handle and its own `close()`
		// governs the lifetime. Nothing below may throw.
		return new Astrograph({ indexer, graphQueries });
	} catch (error) {
		// Exactly once, and never masking the original failure: a close that
		// itself throws must not replace the reason the caller actually needs.
		try {
			storage.close();
		} catch {
			// Intentionally ignored; `error` is the diagnostic that matters.
		}
		throw error;
	}
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/\/$/, "");
}
