import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { INDEX_DIR, loadConfig } from "./config";
import { openDatabase } from "./db";
import { Graph } from "./graph";
import { type SyncOptions, type SyncResult, syncIndex } from "./indexer";

/** Walks up from `start` to the nearest directory holding an index. */
export function findProjectRoot(start: string): string | undefined {
	let dir = resolve(start);
	while (true) {
		if (existsSync(join(dir, INDEX_DIR))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export class Project {
	readonly graph: Graph;
	private lastSync = 0;
	private syncing: Promise<SyncResult> | undefined;

	private constructor(
		readonly root: string,
		readonly db: Database,
	) {
		this.graph = new Graph(db, root);
	}

	/** Opens the index at `root`, creating `.astrograph/` when `create` is set. */
	static open(root: string, opts: { create?: boolean } = {}): Project {
		const abs = resolve(root);
		const dir = join(abs, INDEX_DIR);
		if (!existsSync(dir)) {
			if (!opts.create) throw new NotIndexedError(abs);
			mkdirSync(dir, { recursive: true });
		}
		return new Project(abs, openDatabase(join(dir, "graph.db")));
	}

	/** Opens the nearest indexed project above `start`. */
	static find(start: string): Project {
		const root = findProjectRoot(start);
		if (!root) throw new NotIndexedError(resolve(start));
		return Project.open(root);
	}

	/** Concurrent callers share one in-flight sync. */
	sync(options: SyncOptions = {}): Promise<SyncResult> {
		this.syncing ??= syncIndex(this.db, this.root, loadConfig(this.root), options).finally(() => {
			this.lastSync = Date.now();
			this.syncing = undefined;
		});
		return this.syncing;
	}

	/** Syncs only when the last sync is older than `maxAgeMs`. */
	async ensureFresh(maxAgeMs = 2000): Promise<void> {
		if (Date.now() - this.lastSync >= maxAgeMs) await this.sync();
	}

	close(): void {
		this.db.close();
	}

	/** Deletes the database but keeps `.astrograph/config.json`. */
	static resetDatabase(root: string): void {
		const db = join(resolve(root), INDEX_DIR, "graph.db");
		for (const suffix of ["", "-wal", "-shm"]) rmSync(db + suffix, { force: true });
	}

	/** Removes the whole index directory. */
	static remove(root: string): boolean {
		const dir = join(resolve(root), INDEX_DIR);
		if (!existsSync(dir)) return false;
		rmSync(dir, { recursive: true, force: true });
		return true;
	}
}

export class NotIndexedError extends Error {
	constructor(readonly path: string) {
		super(`no ${INDEX_DIR}/ index found at or above ${path}; run \`astrograph init\` first`);
	}
}
