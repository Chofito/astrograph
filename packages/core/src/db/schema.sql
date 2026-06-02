CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  project         TEXT NOT NULL DEFAULT 'root',
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  qualified_name  TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  language        TEXT NOT NULL,
  start_line      INTEGER NOT NULL,
  end_line        INTEGER NOT NULL,
  start_col       INTEGER NOT NULL,
  end_col         INTEGER NOT NULL,
  signature       TEXT,
  docstring       TEXT,
  visibility      TEXT,
  is_exported     INTEGER NOT NULL DEFAULT 0,
  is_async        INTEGER NOT NULL DEFAULT 0,
  is_static       INTEGER NOT NULL DEFAULT 0,
  is_abstract     INTEGER NOT NULL DEFAULT 0,
  is_external     INTEGER NOT NULL DEFAULT 0,
  is_generated    INTEGER NOT NULL DEFAULT 0,
  is_test         INTEGER NOT NULL DEFAULT 0,
  decorators      TEXT,
  type_parameters TEXT,
  metadata        TEXT,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source           TEXT NOT NULL,
  target           TEXT,
  target_name      TEXT,
  kind             TEXT NOT NULL,
  resolution_state TEXT NOT NULL DEFAULT 'resolved',
  confidence       TEXT NOT NULL DEFAULT 'high',
  provenance       TEXT NOT NULL DEFAULT 'ts-compiler',
  line             INTEGER,
  col              INTEGER,
  metadata         TEXT,
  FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,
  project      TEXT NOT NULL DEFAULT 'root',
  content_hash TEXT NOT NULL,
  language     TEXT NOT NULL,
  size         INTEGER NOT NULL,
  modified_at  INTEGER NOT NULL,
  indexed_at   INTEGER NOT NULL,
  node_count   INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL DEFAULT 'pending',
  errors       TEXT
);

CREATE TABLE IF NOT EXISTS project_metadata (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_versions (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL,
  description TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id UNINDEXED,
  name,
  qualified_name,
  docstring,
  signature,
  content='nodes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS nodes_fts_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
  VALUES (new.rowid, new.id, new.name, new.qualified_name, new.docstring, new.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_delete AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
  VALUES ('delete', old.rowid, old.id, old.name, old.qualified_name, old.docstring, old.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_update AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
  VALUES ('delete', old.rowid, old.id, old.name, old.qualified_name, old.docstring, old.signature);
  INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
  VALUES (new.rowid, new.id, new.name, new.qualified_name, new.docstring, new.signature);
END;

CREATE INDEX IF NOT EXISTS idx_nodes_kind        ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name        ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name  ON nodes(lower(name));
CREATE INDEX IF NOT EXISTS idx_nodes_qname       ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file        ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_file_line   ON nodes(file_path, start_line);
CREATE INDEX IF NOT EXISTS idx_nodes_language    ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_project     ON nodes(project);

CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);
CREATE INDEX IF NOT EXISTS idx_edges_kind        ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_unresolved  ON edges(resolution_state, target_name);

CREATE INDEX IF NOT EXISTS idx_files_language    ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_state       ON files(state);
