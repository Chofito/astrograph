import { describe, expect, test } from "bun:test";
import { BunSqliteStorageAdapter } from "../adapters/bun/sqlite";
import { IncompatibleIndexError } from "../types";
import {
	getCurrentSchemaVersion,
	LATEST_SCHEMA_VERSION,
	runMigrations,
} from "./migrations";

const NOW = 1_700_000_000_000;

function memoryDb(): BunSqliteStorageAdapter {
	return new BunSqliteStorageAdapter(":memory:");
}

describe("runMigrations", () => {
	test("brings an empty database up to the latest schema version", () => {
		const db = memoryDb();
		try {
			runMigrations(db, { now: () => NOW });
			expect(getCurrentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
		} finally {
			db.close();
		}
	});

	test("is idempotent: re-running applies nothing and does not throw", () => {
		const db = memoryDb();
		try {
			runMigrations(db, { now: () => NOW });
			runMigrations(db, { now: () => NOW });
			expect(getCurrentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
		} finally {
			db.close();
		}
	});

	test("refuses an index written by a newer binary instead of opening it", () => {
		const db = memoryDb();
		try {
			runMigrations(db, { now: () => NOW });
			// Simulate a database a future Astrograph wrote.
			const future = LATEST_SCHEMA_VERSION + 1;
			db.prepare(
				"INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)",
			).run(future, NOW, "written by a newer binary");

			expect(() => runMigrations(db, { now: () => NOW })).toThrow(
				IncompatibleIndexError,
			);

			// The message has to tell the user what to actually do.
			try {
				runMigrations(db, { now: () => NOW });
			} catch (error) {
				const incompatible = error as IncompatibleIndexError;
				expect(incompatible.code).toBe("INCOMPATIBLE_INDEX");
				expect(incompatible.found).toBe(future);
				expect(incompatible.supported).toBe(LATEST_SCHEMA_VERSION);
				expect(incompatible.message).toContain("astrograph index");
			}
		} finally {
			db.close();
		}
	});
});
