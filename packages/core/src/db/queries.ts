import type {
  Confidence,
  Coverage,
  CoverageState,
  Edge,
  EdgeKind,
  EdgeRef,
  ExtractionError,
  FileRecord,
  Language,
  Node,
  NodeKind,
  NodeRef,
  Provenance,
  ResolutionState,
  SearchInput,
  SearchOutput,
  StatusOutput,
  StorageAdapter,
  Visibility,
} from '../types';
import { toExactNameBoostToken, toFtsMatchQuery } from '../search/fts-query';

type JsonRecord = Record<string, unknown>;

interface NodeRow {
  id: string;
  project: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_col: number;
  end_col: number;
  signature: string | null;
  docstring: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  is_external: number;
  is_generated: number;
  is_test: number;
  decorators: string | null;
  type_parameters: string | null;
  metadata: string | null;
  updated_at: number;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string | null;
  target_name: string | null;
  kind: string;
  resolution_state: string;
  confidence: string;
  provenance: string;
  line: number | null;
  col: number | null;
  metadata: string | null;
}

interface FileRow {
  path: string;
  project: string;
  content_hash: string;
  language: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  state: string;
  errors: string | null;
}

export class QueryBuilder {
  constructor(private readonly db: StorageAdapter) {}

  upsertNode(node: Node): void {
    this.db.prepare(`INSERT INTO nodes (
      id, project, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_col, end_col,
      signature, docstring, visibility,
      is_exported, is_async, is_static, is_abstract,
      is_external, is_generated, is_test,
      decorators, type_parameters, metadata, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project=excluded.project,
      kind=excluded.kind,
      name=excluded.name,
      qualified_name=excluded.qualified_name,
      file_path=excluded.file_path,
      language=excluded.language,
      start_line=excluded.start_line,
      end_line=excluded.end_line,
      start_col=excluded.start_col,
      end_col=excluded.end_col,
      signature=excluded.signature,
      docstring=excluded.docstring,
      visibility=excluded.visibility,
      is_exported=excluded.is_exported,
      is_async=excluded.is_async,
      is_static=excluded.is_static,
      is_abstract=excluded.is_abstract,
      is_external=excluded.is_external,
      is_generated=excluded.is_generated,
      is_test=excluded.is_test,
      decorators=excluded.decorators,
      type_parameters=excluded.type_parameters,
      metadata=excluded.metadata,
      updated_at=excluded.updated_at`).run(
      node.id,
      node.project,
      node.kind,
      node.name,
      node.qualifiedName,
      node.filePath,
      node.language,
      node.range.startLine,
      node.range.endLine,
      node.range.startColumn,
      node.range.endColumn,
      node.signature ?? null,
      node.docstring ?? null,
      node.visibility ?? null,
      boolToInt(node.isExported),
      boolToInt(node.isAsync),
      boolToInt(node.isStatic),
      boolToInt(node.isAbstract),
      boolToInt(node.isExternal),
      boolToInt(node.isGenerated),
      boolToInt(node.isTest),
      writeJson(node.decorators),
      writeJson(node.typeParameters),
      writeJson(node.metadata),
      node.updatedAt,
    );
  }

  getNode(id: string): Node | undefined {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | null | undefined;
    return row == null ? undefined : mapNode(row);
  }

  getNodesByFile(filePath: string): Node[] {
    return this.db.prepare(
      `SELECT * FROM nodes
       WHERE file_path = ?
       ORDER BY file_path ASC, start_line ASC, kind ASC, qualified_name ASC`,
    ).all(filePath).map((row) => mapNode(row as NodeRow));
  }

  getAllNodes(): Node[] {
    return this.db.prepare(
      `SELECT * FROM nodes
       ORDER BY file_path ASC, start_line ASC, kind ASC, qualified_name ASC`,
    ).all().map((row) => mapNode(row as NodeRow));
  }

  findNodesByName(name: string, limit = 25): Node[] {
    return this.db.prepare(
      `SELECT * FROM nodes
       WHERE lower(name) = lower(?) OR lower(qualified_name) = lower(?)
       ORDER BY is_generated ASC, is_test ASC, is_exported DESC,
         file_path ASC, start_line ASC, kind ASC, qualified_name ASC
       LIMIT ?`,
    ).all(name, name, limit).map((row) => mapNode(row as NodeRow));
  }

  getNodesByIds(ids: string[]): Node[] {
    if (ids.length === 0) return [];
    const uniqueIds = [...new Set(ids)].sort(compareStrings);
    const placeholders = uniqueIds.map(() => '?').join(', ');
    return this.db.prepare(
      `SELECT * FROM nodes
       WHERE id IN (${placeholders})
       ORDER BY file_path ASC, start_line ASC, kind ASC, qualified_name ASC`,
    ).all(...uniqueIds).map((row) => mapNode(row as NodeRow));
  }

  deleteNode(id: string): number {
    return this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id).changes;
  }

  deleteByFile(filePath: string): { deletedNodes: number; deletedFiles: number } {
    const remove = this.db.transaction(() => {
      const deletedNodes = this.db.prepare('DELETE FROM nodes WHERE file_path = ?').run(filePath).changes;
      const deletedFiles = this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath).changes;
      return { deletedNodes, deletedFiles };
    });
    return remove() as { deletedNodes: number; deletedFiles: number };
  }

  upsertEdge(edge: Edge): Edge {
    if (edge.id !== undefined) {
      this.db.prepare(`UPDATE edges SET
        source=?, target=?, target_name=?, kind=?, resolution_state=?,
        confidence=?, provenance=?, line=?, col=?, metadata=?
        WHERE id=?`).run(
        edge.source,
        edge.target,
        edge.targetName ?? null,
        edge.kind,
        edge.resolutionState,
        edge.confidence,
        edge.provenance,
        edge.line ?? null,
        edge.col ?? null,
        writeJson(edge.metadata),
        edge.id,
      );
      return edge;
    }

    const result = this.db.prepare(`INSERT INTO edges (
      source, target, target_name, kind, resolution_state,
      confidence, provenance, line, col, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      edge.source,
      edge.target,
      edge.targetName ?? null,
      edge.kind,
      edge.resolutionState,
      edge.confidence,
      edge.provenance,
      edge.line ?? null,
      edge.col ?? null,
      writeJson(edge.metadata),
    );

    return { ...edge, id: Number(result.lastInsertRowid) };
  }

  getEdge(id: number): Edge | undefined {
    const row = this.db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as EdgeRow | null | undefined;
    return row == null ? undefined : mapEdge(row);
  }

  getAllEdges(): Edge[] {
    return this.db.prepare(
      `SELECT * FROM edges
       ORDER BY source ASC, kind ASC, COALESCE(target, '') ASC, COALESCE(line, -1) ASC, id ASC`,
    ).all().map((row) => mapEdge(row as EdgeRow));
  }

  getEdgesByKind(kind: EdgeKind): Edge[] {
    return this.db.prepare(
      `SELECT * FROM edges
       WHERE kind = ?
       ORDER BY source ASC, kind ASC, COALESCE(target, '') ASC, COALESCE(line, -1) ASC, id ASC`,
    ).all(kind).map((row) => mapEdge(row as EdgeRow));
  }

  getEdgesBySource(source: string, kind?: EdgeKind): Edge[] {
    const sql = kind === undefined
      ? `SELECT * FROM edges WHERE source = ?
         ORDER BY source ASC, kind ASC, COALESCE(target, '') ASC, COALESCE(line, -1) ASC, id ASC`
      : `SELECT * FROM edges WHERE source = ? AND kind = ?
         ORDER BY source ASC, kind ASC, COALESCE(target, '') ASC, COALESCE(line, -1) ASC, id ASC`;
    const params = kind === undefined ? [source] : [source, kind];
    return this.db.prepare(sql).all(...params).map((row) => mapEdge(row as EdgeRow));
  }

  getEdgesByTarget(target: string, kind?: EdgeKind): Edge[] {
    const sql = kind === undefined
      ? `SELECT * FROM edges WHERE target = ?
         ORDER BY source ASC, kind ASC, COALESCE(target, '') ASC, COALESCE(line, -1) ASC, id ASC`
      : `SELECT * FROM edges WHERE target = ? AND kind = ?
         ORDER BY source ASC, kind ASC, COALESCE(target, '') ASC, COALESCE(line, -1) ASC, id ASC`;
    const params = kind === undefined ? [target] : [target, kind];
    return this.db.prepare(sql).all(...params).map((row) => mapEdge(row as EdgeRow));
  }

  getEdgesByResolutionStateAndTargetName(
    resolutionState: ResolutionState,
    targetName: string,
  ): Edge[] {
    return this.db.prepare(
      `SELECT * FROM edges
       WHERE resolution_state = ? AND target_name = ?
       ORDER BY source ASC, kind ASC, COALESCE(target, '') ASC, COALESCE(line, -1) ASC, id ASC`,
    ).all(resolutionState, targetName).map((row) => mapEdge(row as EdgeRow));
  }

  getDanglingEdges(): Edge[] {
    return this.db.prepare(
      `SELECT e.* FROM edges e
       LEFT JOIN nodes source_node ON source_node.id = e.source
       LEFT JOIN nodes target_node ON target_node.id = e.target
       WHERE source_node.id IS NULL OR (e.target IS NOT NULL AND target_node.id IS NULL)
       ORDER BY e.source ASC, e.kind ASC, COALESCE(e.target, '') ASC, COALESCE(e.line, -1) ASC, e.id ASC`,
    ).all().map((row) => mapEdge(row as EdgeRow));
  }

  deleteEdge(id: number): number {
    return this.db.prepare('DELETE FROM edges WHERE id = ?').run(id).changes;
  }

  upsertFile(file: FileRecord): void {
    this.db.prepare(`INSERT INTO files (
      path, project, content_hash, language, size,
      modified_at, indexed_at, node_count, state, errors
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      project=excluded.project,
      content_hash=excluded.content_hash,
      language=excluded.language,
      size=excluded.size,
      modified_at=excluded.modified_at,
      indexed_at=excluded.indexed_at,
      node_count=excluded.node_count,
      state=excluded.state,
      errors=excluded.errors`).run(
      file.path,
      file.project,
      file.contentHash,
      file.language,
      file.size,
      file.modifiedAt,
      file.indexedAt,
      file.nodeCount,
      file.state,
      writeJson(file.errors),
    );
  }

  getFile(path: string): FileRecord | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | null | undefined;
    return row == null ? undefined : mapFile(row);
  }

  getAllFiles(): FileRecord[] {
    return this.db.prepare('SELECT * FROM files ORDER BY path ASC')
      .all()
      .map((row) => mapFile(row as FileRow));
  }

  getPendingFiles(limit = 25, paths?: string[]): string[] {
    if (paths !== undefined) {
      if (paths.length === 0) return [];
      const uniquePaths = [...new Set(paths)].sort(compareStrings);
      const placeholders = uniquePaths.map(() => '?').join(', ');
      return this.db.prepare(
        `SELECT path FROM files
         WHERE state != 'resolved' AND path IN (${placeholders})
         ORDER BY path ASC
         LIMIT ?`,
      ).all(...uniquePaths, limit).map((row) => (row as { path: string }).path);
    }

    return this.db.prepare(
      `SELECT path FROM files
       WHERE state != 'resolved'
       ORDER BY path ASC
       LIMIT ?`,
    ).all(limit).map((row) => (row as { path: string }).path);
  }

  deleteFile(path: string): number {
    return this.db.prepare('DELETE FROM files WHERE path = ?').run(path).changes;
  }

  search(input: SearchInput): SearchOutput {
    if (input.query.trim() === '') return [];

    const matchQuery = toFtsMatchQuery(input.query);
    if (matchQuery === '') return [];
    const exactNameBoostToken = toExactNameBoostToken(input.query);

    const limit = input.limit ?? 10;
    const clauses = ['nodes_fts MATCH ?'];
    const params: unknown[] = [exactNameBoostToken, matchQuery];

    if (input.kind !== undefined) {
      clauses.push('n.kind = ?');
      params.push(input.kind);
    }
    if (input.lang !== undefined) {
      clauses.push('n.language = ?');
      params.push(input.lang);
    }
    if (input.includeGenerated !== true) {
      clauses.push('n.is_generated = 0');
    }
    params.push(limit);

    const rows = this.db.prepare(
      `SELECT n.*,
        bm25(nodes_fts, 0, 20, 5, 1, 2)
          - CASE WHEN lower(n.name) = ? THEN 1000 ELSE 0 END AS rank
       FROM nodes_fts
       JOIN nodes n ON n.rowid = nodes_fts.rowid
       WHERE ${clauses.join(' AND ')}
       ORDER BY rank ASC, n.file_path ASC, n.start_line ASC, n.kind ASC, n.qualified_name ASC
       LIMIT ?`,
    ).all(...params) as (NodeRow & { rank: number })[];

    return rows.map((row) => ({
      node: toNodeRef(mapNode(row)),
      score: -Number(row.rank),
    }));
  }

  getCoverage(paths?: string[]): Coverage {
    const coverage: Coverage = { total: 0, resolved: 0, parsed: 0, pending: 0 };
    const rows = paths === undefined
      ? this.db.prepare('SELECT state, COUNT(*) AS count FROM files GROUP BY state ORDER BY state ASC').all()
      : this.selectCoverageForPaths(paths);

    for (const row of rows as { state: CoverageState; count: number }[]) {
      const count = Number(row.count);
      coverage.total += count;
      if (row.state === 'resolved') coverage.resolved = count;
      if (row.state === 'parsed') coverage.parsed = count;
      if (row.state === 'pending') coverage.pending = count;
    }

    return coverage;
  }

  getStats(): StatusOutput {
    const coverage = this.getCoverage();
    const pendingSync = this.db.prepare(
      `SELECT path FROM files WHERE state != 'resolved' ORDER BY path ASC`,
    ).all().map((row) => (row as { path: string }).path);

    return {
      nodeCount: this.countRows('nodes'),
      edgeCount: this.countRows('edges'),
      fileCount: this.countRows('files'),
      nodesByKind: this.countBy('nodes', 'kind'),
      edgesByKind: this.countBy('edges', 'kind'),
      filesByLanguage: this.countBy('files', 'language'),
      coverage,
      pendingSync: pendingSync.length > 0 ? pendingSync : undefined,
      dbSizeBytes: this.getDbSizeBytes(),
      lastUpdated: this.getLastUpdated(),
      backend: 'bun:sqlite',
      journalMode: String(this.db.pragma('journal_mode', { simple: true })),
    };
  }

  private selectCoverageForPaths(paths: string[]): { state: CoverageState; count: number }[] {
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => '?').join(', ');
    return this.db.prepare(
      `SELECT state, COUNT(*) AS count FROM files
       WHERE path IN (${placeholders})
       GROUP BY state
       ORDER BY state ASC`,
    ).all(...paths) as { state: CoverageState; count: number }[];
  }

  private countRows(table: 'nodes' | 'edges' | 'files'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return Number(row.count);
  }

  private countBy(table: 'nodes' | 'edges' | 'files', column: 'kind' | 'language'): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT ${column} AS key, COUNT(*) AS count FROM ${table} GROUP BY ${column} ORDER BY ${column} ASC`,
    ).all() as { key: string; count: number }[];
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.key] = Number(row.count);
    return counts;
  }

  private getDbSizeBytes(): number {
    const pageCount = Number(this.db.pragma('page_count', { simple: true }) ?? 0);
    const pageSize = Number(this.db.pragma('page_size', { simple: true }) ?? 0);
    return pageCount * pageSize;
  }

  private getLastUpdated(): number {
    const row = this.db.prepare(
      `SELECT MAX(value) AS last_updated FROM (
         SELECT MAX(updated_at) AS value FROM nodes
         UNION ALL
         SELECT MAX(indexed_at) AS value FROM files
         UNION ALL
         SELECT MAX(updated_at) AS value FROM project_metadata
       )`,
    ).get() as { last_updated: number | null };
    return row.last_updated ?? 0;
  }
}

export function toNodeRef(node: Node): NodeRef {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    range: node.range,
    signature: node.signature,
  };
}

export function toEdgeRef(edge: Edge): EdgeRef {
  return {
    source: edge.source,
    target: edge.target,
    targetName: edge.targetName,
    kind: edge.kind,
    resolutionState: edge.resolutionState,
    confidence: edge.confidence,
    line: edge.line,
    col: edge.col,
  };
}

function mapNode(row: NodeRow): Node {
  return {
    id: row.id,
    project: row.project,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language as Language,
    range: {
      startLine: row.start_line,
      endLine: row.end_line,
      startColumn: row.start_col,
      endColumn: row.end_col,
    },
    signature: row.signature ?? undefined,
    docstring: row.docstring ?? undefined,
    visibility: (row.visibility ?? undefined) as Visibility | undefined,
    isExported: intToBool(row.is_exported),
    isAsync: intToBool(row.is_async),
    isStatic: intToBool(row.is_static),
    isAbstract: intToBool(row.is_abstract),
    isExternal: intToBool(row.is_external),
    isGenerated: intToBool(row.is_generated),
    isTest: intToBool(row.is_test),
    decorators: readJson<string[]>(row.decorators),
    typeParameters: readJson<string[]>(row.type_parameters),
    metadata: readJson<JsonRecord>(row.metadata),
    updatedAt: row.updated_at,
  };
}

function mapEdge(row: EdgeRow): Edge {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    targetName: row.target_name ?? undefined,
    kind: row.kind as EdgeKind,
    resolutionState: row.resolution_state as ResolutionState,
    confidence: row.confidence as Confidence,
    provenance: row.provenance as Provenance,
    line: row.line ?? undefined,
    col: row.col ?? undefined,
    metadata: readJson<JsonRecord>(row.metadata),
  };
}

function mapFile(row: FileRow): FileRecord {
  return {
    path: row.path,
    project: row.project,
    contentHash: row.content_hash,
    language: row.language as Language,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    state: row.state as CoverageState,
    errors: readJson<ExtractionError[]>(row.errors),
  };
}

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

function intToBool(value: number): boolean {
  return value === 1;
}

function writeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function readJson<T>(value: string | null): T | undefined {
  if (value === null || value === '') return undefined;
  return JSON.parse(value) as T;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
