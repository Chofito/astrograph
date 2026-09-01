import { mkdir } from "node:fs/promises";
import { Astrograph } from "../../astrograph";
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
import type { AstrographConfig } from "../../config";
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

	return new Astrograph({ indexer, graphQueries });
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/\/$/, "");
}
