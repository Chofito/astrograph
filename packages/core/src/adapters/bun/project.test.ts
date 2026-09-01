import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runMigrations } from "../../db/migrations";
import type { StorageAdapter } from "../../types";
import { IncompatibleIndexError } from "../../types";
import { openProject, openProjectWithDependencies } from "./project";
import { BunSqliteStorageAdapter } from "./sqlite";

/**
 * AG-209 finding 5: `openProject` opened a SQLite handle and only then ran
 * migrations, built the registry and loaded grammars. Any of those can throw —
 * an index written by a newer build is the common one — and the handle was left
 * to the garbage collector with nobody holding a reference.
 */

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

async function makeProjectRoot(): Promise<string> {
	const root = await mkdtemp(`${tmpdir()}/astrograph-open-`);
	tempRoots.push(root);
	await mkdir(`${root}/src`, { recursive: true });
	await writeFile(`${root}/src/a.ts`, "export function a() { return 1; }\n");
	return root;
}

/** Seed a database that claims a schema version this build cannot read. */
function writeFutureIndex(dbPath: string): void {
	const storage = new BunSqliteStorageAdapter(dbPath);
	try {
		runMigrations(storage, { now: () => 1 });
		storage
			.prepare(
				"INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)",
			)
			.run(999, 1, "written by a newer Astrograph");
	} finally {
		storage.close();
	}
}

class CloseSpyStorage implements StorageAdapter {
	readonly #storage: BunSqliteStorageAdapter;
	closeCalls = 0;

	constructor(path: string) {
		this.#storage = new BunSqliteStorageAdapter(path);
	}

	get open(): boolean {
		return this.#storage.open;
	}

	prepare(sql: string) {
		return this.#storage.prepare(sql);
	}

	exec(sql: string): void {
		this.#storage.exec(sql);
	}

	transaction<T>(fn: (...a: unknown[]) => T): (...a: unknown[]) => T {
		return this.#storage.transaction(fn);
	}

	pragma(s: string, opts?: { simple?: boolean }): unknown {
		return this.#storage.pragma(s, opts);
	}

	close(): void {
		this.closeCalls += 1;
		this.#storage.close();
	}
}

describe("openProject releases storage when initialization fails", () => {
	test("closes exactly once and preserves the initialization error", async () => {
		const root = await makeProjectRoot();
		await mkdir(`${root}/.astrograph`, { recursive: true });
		const dbPath = `${root}/.astrograph/graph.db`;
		writeFutureIndex(dbPath);
		let storage: CloseSpyStorage | undefined;

		const failure = await openProjectWithDependencies(root, { dbPath }, {
			createStorage: (path) => {
				storage = new CloseSpyStorage(path);
				return storage;
			},
		}).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(IncompatibleIndexError);
		expect(failure).toMatchObject({
			message: expect.stringMatching(/delete .astrograph\/graph.db/),
		});
		expect(storage?.closeCalls).toBe(1);
	});

	test("a normal project opening still returns a usable graph", async () => {
		const root = await makeProjectRoot();
		const graph = await openProject(root);
		try {
			await graph.indexAll();
			expect(graph.queries.getAllFiles().map((f) => f.path)).toEqual([
				"src/a.ts",
			]);
		} finally {
			graph.close();
		}
	});

	test("each failed opening closes the storage it created", async () => {
		const root = await makeProjectRoot();
		await mkdir(`${root}/.astrograph`, { recursive: true });
		const dbPath = `${root}/.astrograph/graph.db`;
		writeFutureIndex(dbPath);
		const storages: CloseSpyStorage[] = [];

		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(
				openProjectWithDependencies(root, { dbPath }, {
					createStorage: (path) => {
						const storage = new CloseSpyStorage(path);
						storages.push(storage);
						return storage;
					},
				}),
			).rejects.toThrow(IncompatibleIndexError);
		}

		expect(storages.map((storage) => storage.closeCalls)).toEqual([1, 1, 1]);
	});
});
