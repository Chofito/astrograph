import { mkdir } from "node:fs/promises";
import { Astrograph } from "../../astrograph";
import type { AstrographConfig } from "../../config";
import { runMigrations } from "../../db/migrations";
import { QueryBuilder } from "../../db/queries";
import {
	createDefaultRegistry,
	grammarsForRegistry,
	initTreeSitter,
	loadGrammars,
} from "../../extraction";
import { Indexer } from "../../indexer";
import { GraphQueries } from "../../query/graph-queries";
import { BunFileSystem } from "./fs";
import { BunGlobScanner } from "./glob";
import { BunHasher } from "./hasher";
import { BunSqliteStorageAdapter } from "./sqlite";

export interface OpenProjectOptions {
	config?: AstrographConfig;
	now?: () => number;
	dbPath?: string;
}

/** Compose a Bun-backed project graph and initialize its storage and grammars. */
export async function openProject(
	rootPath: string,
	opts: OpenProjectOptions = {},
): Promise<Astrograph> {
	const root = normalizePath(rootPath);
	const astrographDir = `${root}/.astrograph`;
	await mkdir(astrographDir, { recursive: true });

	const storage = new BunSqliteStorageAdapter(
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
		const registry = createDefaultRegistry({
			hasher,
			now: opts.now,
			project: "root",
			config: opts.config,
		});

		await initTreeSitter();
		await loadGrammars(grammarsForRegistry(registry));

		const glob = new BunGlobScanner({ extensions: registry.allExtensions() });

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
