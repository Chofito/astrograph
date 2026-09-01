import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runMigrations } from "../../db/migrations";
import { IncompatibleIndexError } from "../../types";
import { openProject } from "./project";
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

describe("openProject releases storage when initialization fails", () => {
	test("an incompatible index surfaces its own error, unmasked", async () => {
		const root = await makeProjectRoot();
		await mkdir(`${root}/.astrograph`, { recursive: true });
		const dbPath = `${root}/.astrograph/graph.db`;
		writeFutureIndex(dbPath);

		// The cleanup path must never replace the reason the caller needs.
		await expect(openProject(root, { dbPath })).rejects.toThrow(
			IncompatibleIndexError,
		);
		await expect(openProject(root, { dbPath })).rejects.toThrow(
			/delete .astrograph\/graph.db/,
		);
	});

	test("the project opens normally once the bad index is removed", async () => {
		const root = await makeProjectRoot();
		await mkdir(`${root}/.astrograph`, { recursive: true });
		const dbPath = `${root}/.astrograph/graph.db`;
		writeFutureIndex(dbPath);

		await expect(openProject(root, { dbPath })).rejects.toThrow(
			IncompatibleIndexError,
		);

		// The documented recovery in the error message must actually work. A
		// handle still held on the old file is what would break it.
		await rm(dbPath, { force: true });
		await rm(`${dbPath}-wal`, { force: true });
		await rm(`${dbPath}-shm`, { force: true });

		const graph = await openProject(root, { dbPath });
		try {
			await graph.indexAll();
			expect(graph.queries.getAllFiles().map((f) => f.path)).toEqual([
				"src/a.ts",
			]);
		} finally {
			graph.close();
		}
	});

	test("repeated failures do not accumulate handles", async () => {
		const root = await makeProjectRoot();
		await mkdir(`${root}/.astrograph`, { recursive: true });
		const dbPath = `${root}/.astrograph/graph.db`;
		writeFutureIndex(dbPath);

		for (let attempt = 0; attempt < 25; attempt++) {
			await expect(openProject(root, { dbPath })).rejects.toThrow(
				IncompatibleIndexError,
			);
		}

		// Twenty-five leaked connections would be twenty-five live WAL readers.
		await rm(dbPath, { force: true });
		await rm(`${dbPath}-wal`, { force: true });
		await rm(`${dbPath}-shm`, { force: true });
		const graph = await openProject(root, { dbPath });
		graph.close();
	});
});
