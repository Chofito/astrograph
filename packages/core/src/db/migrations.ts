import schemaSql from './schema.sql' with { type: 'text' };
import type { StorageAdapter } from '../types';

export const LATEST_SCHEMA_VERSION = 1;

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export interface MigrationOptions {
  now?: () => number;
}

export const INITIAL_SCHEMA_SQL = schemaSql;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'Initial graph storage schema',
    sql: INITIAL_SCHEMA_SQL,
  },
];

export function getAppliedMigrationVersions(db: StorageAdapter): number[] {
  ensureSchemaVersionsTable(db);
  return db.prepare('SELECT version FROM schema_versions ORDER BY version ASC')
    .all()
    .map((row) => Number((row as { version: number }).version));
}

export function runMigrations(db: StorageAdapter, options: MigrationOptions = {}): void {
  const now = options.now ?? Date.now;
  const applied = new Set(getAppliedMigrationVersions(db));
  const migrate = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)',
      ).run(migration.version, now(), migration.description);
    }
  });

  migrate();
}

export function getCurrentSchemaVersion(db: StorageAdapter): number {
  ensureSchemaVersionsTable(db);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_versions').get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

function ensureSchemaVersionsTable(db: StorageAdapter): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL,
  description TEXT
);`);
}
