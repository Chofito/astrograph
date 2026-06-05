import { mkdir } from "node:fs/promises";
import type { AstrographConfig } from "../../types";
import { QueryBuilder } from "../../db/queries";
import { runMigrations } from "../../db/migrations";
import { TsExtractor } from "../../extraction";
import { Indexer } from "../../indexer";
import { Astrograph } from "../../astrograph";
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
	const glob = new BunGlobScanner();
	const extractor = new TsExtractor({ hasher, now: opts.now, project: "root" });

	const indexer = new Indexer({
		queries,
		storage,
		fs,
		hasher,
		glob,
		extractor,
		config: opts.config,
		root,
		now: opts.now,
	});
	const graphQueries = new GraphQueries({ queries, fs, root });

	return new Astrograph({ indexer, graphQueries });
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/\/$/, "");
}
