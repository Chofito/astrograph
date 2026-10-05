import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/** Bump when the schema or extraction output changes; old indexes are rebuilt, never migrated. */
export const SCHEMA_VERSION = "4";

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE files (
	id INTEGER PRIMARY KEY,
	path TEXT NOT NULL UNIQUE,
	lang TEXT NOT NULL,
	size INTEGER NOT NULL,
	mtime REAL NOT NULL,
	hash TEXT NOT NULL,
	lines INTEGER NOT NULL,
	error TEXT
);

CREATE TABLE symbols (
	id INTEGER PRIMARY KEY,
	file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	parent_id INTEGER,
	name TEXT NOT NULL,
	qualified_name TEXT NOT NULL,
	kind TEXT NOT NULL,
	exported INTEGER NOT NULL,
	start_line INTEGER NOT NULL,
	end_line INTEGER NOT NULL,
	signature TEXT NOT NULL,
	return_type TEXT
);
CREATE INDEX symbols_name ON symbols(name COLLATE NOCASE);
CREATE INDEX symbols_qualified ON symbols(qualified_name);
CREATE INDEX symbols_file ON symbols(file_id);

-- resolution: exact | inferred | ambiguous | external | unresolved
CREATE TABLE refs (
	id INTEGER PRIMARY KEY,
	file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	from_id INTEGER,
	kind TEXT NOT NULL,
	name TEXT NOT NULL,
	receiver TEXT,
	hints TEXT,
	line INTEGER NOT NULL,
	target_id INTEGER,
	resolution TEXT NOT NULL DEFAULT 'unresolved'
);
CREATE INDEX refs_target ON refs(target_id);
CREATE INDEX refs_from ON refs(from_id);
CREATE INDEX refs_file ON refs(file_id);

CREATE TABLE imports (
	id INTEGER PRIMARY KEY,
	file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	local TEXT NOT NULL,
	imported TEXT NOT NULL,
	source TEXT,
	reexport INTEGER NOT NULL,
	resolved_file_id INTEGER
);
CREATE INDEX imports_file ON imports(file_id);
`;

/**
 * Opens (or creates) the index. An index with another schema version is
 * deleted and recreated: it is a disposable cache of the source tree.
 */
export function openDatabase(path: string): Database {
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path)) {
		const db = configure(new Database(path));
		if (readVersion(db) === SCHEMA_VERSION) return db;
		db.close();
		for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
	}
	const db = configure(new Database(path, { create: true }));
	db.transaction(() => {
		db.exec(SCHEMA);
		setMeta(db, "schema_version", SCHEMA_VERSION);
	})();
	return db;
}

function configure(db: Database): Database {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 10000");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA synchronous = NORMAL");
	return db;
}

function readVersion(db: Database): string | undefined {
	try {
		return getMeta(db, "schema_version");
	} catch {
		return undefined;
	}
}

export function getMeta(db: Database, key: string): string | undefined {
	const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
	return row?.value;
}

export function setMeta(db: Database, key: string, value: string): void {
	db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
		key,
		value,
	);
}
