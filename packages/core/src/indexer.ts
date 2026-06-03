import ts from 'typescript';
import type {
  AstrographConfig,
  ExtractionError,
  FileRecord,
  FileSystem,
  GlobScanner,
  Hasher,
  IndexProgress,
  ProjectExtractor,
  StorageAdapter,
  WatchEvent,
} from './types';
import { QueryBuilder } from './db/queries';
import { languageFromPath } from './extraction/language';

export interface IndexerOptions {
  queries: QueryBuilder;
  storage: StorageAdapter;
  fs: FileSystem;
  hasher: Hasher;
  glob: GlobScanner;
  extractor: ProjectExtractor;
  config?: AstrographConfig;
  root: string;
  now?: () => number;
}

export interface IndexAllOptions {
  force?: boolean;
  onProgress?: (e: IndexProgress) => void;
}

export class Indexer {
  readonly queries: QueryBuilder;

  private readonly storage: StorageAdapter;
  private readonly fs: FileSystem;
  private readonly hasher: Hasher;
  private readonly glob: GlobScanner;
  private readonly extractor: ProjectExtractor;
  private readonly config: AstrographConfig;
  private readonly root: string;
  private readonly now: () => number;

  constructor(options: IndexerOptions) {
    this.queries = options.queries;
    this.storage = options.storage;
    this.fs = options.fs;
    this.hasher = options.hasher;
    this.glob = options.glob;
    this.extractor = options.extractor;
    this.config = options.config ?? {};
    this.root = normalizePath(options.root);
    this.now = options.now ?? Date.now;
  }

  async indexAll(options: IndexAllOptions = {}): Promise<void> {
    const configHash = await this.computeConfigHash();
    const files = await this.scanFiles();

    options.onProgress?.({ phase: 'scan', current: files.length, total: files.length });

    this.extractor.loadProject({
      rootPath: this.root,
      tsconfigPath: this.config.tsconfigPath,
      fileNames: files,
      loadNodesForFile: (filePath) => this.queries.getNodesByFile(filePath),
    });

    for (let i = 0; i < files.length; i++) {
      const relPath = files[i]!;
      options.onProgress?.({ phase: 'parse', current: i + 1, total: files.length, file: relPath });
      await this.indexFilePassA(relPath, { force: options.force ?? false });
    }

    for (let i = 0; i < files.length; i++) {
      const relPath = files[i]!;
      options.onProgress?.({ phase: 'resolve', current: i + 1, total: files.length, file: relPath });
      this.indexFilePassB(relPath);
    }

    this.persistProjectMetadata(configHash);
    options.onProgress?.({ phase: 'done', current: files.length, total: files.length });
  }

  async sync(): Promise<{ added: string[]; modified: string[]; removed: string[] }> {
    const configHash = await this.computeConfigHash();
    const storedConfigHash = this.getProjectMetadata('configHash');
    const configChanged = storedConfigHash !== undefined && storedConfigHash !== configHash;

    const scanned = await this.scanFiles();
    const scannedSet = new Set(scanned);
    const knownFiles = this.queries.getAllFiles();
    const knownByPath = new Map(knownFiles.map((file) => [file.path, file]));

    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    const maxFileSizeBytes = this.config.maxFileSizeBytes ?? 2_000_000;

    for (const relPath of scanned) {
      const stat = await this.fs.stat(this.joinRoot(relPath));
      const contentHash = stat.size > maxFileSizeBytes
        ? ''
        : this.hasher.hash(await this.fs.readText(this.joinRoot(relPath)));
      const known = knownByPath.get(relPath);

      if (known === undefined) {
        added.push(relPath);
      } else if (configChanged || known.contentHash !== contentHash) {
        modified.push(relPath);
      }
    }

    for (const file of knownFiles) {
      if (!scannedSet.has(file.path)) removed.push(file.path);
    }

    const changedFiles = [...added, ...modified];

    const referrerFiles = this.findReferrerFilesForTargets(changedFiles);

    for (const relPath of removed) {
      const priorNodeIds = this.queries.getNodesByFile(relPath).map((n) => n.id);
      const incomingEdges = this.findIncomingEdges(priorNodeIds);
      this.queries.deleteByFile(relPath);
      this.markIncomingEdgesUnresolved(incomingEdges);
    }

    if (changedFiles.length > 0) {
      this.extractor.loadProject({
        rootPath: this.root,
        tsconfigPath: this.config.tsconfigPath,
        fileNames: scanned,
        loadNodesForFile: (filePath) => this.queries.getNodesByFile(filePath),
      });

      for (const relPath of changedFiles) {
        await this.indexFilePassA(relPath, { force: true });
      }

      for (const relPath of changedFiles) {
        this.indexFilePassB(relPath);
      }

      for (const relPath of referrerFiles) {
        this.indexFilePassB(relPath);
      }

      this.healUnresolvedEdges(changedFiles);
    }

    this.persistProjectMetadata(configHash);

    return {
      added: added.sort(compareStrings),
      modified: modified.sort(compareStrings),
      removed: removed.sort(compareStrings),
    };
  }

  async syncFiles(events: WatchEvent[]): Promise<{ added: string[]; modified: string[]; removed: string[] }> {
    const normalizedEvents = mergeEvents(events);
    const removed = normalizedEvents
      .filter((event) => event.type === 'unlink')
      .map((event) => event.path);
    const changedCandidates = normalizedEvents
      .filter((event) => event.type !== 'unlink')
      .map((event) => event.path);

    const added: string[] = [];
    const modified: string[] = [];
    const changedFiles: string[] = [];
    const maxFileSizeBytes = this.config.maxFileSizeBytes ?? 2_000_000;

    for (const relPath of changedCandidates) {
      const absolutePath = this.joinRoot(relPath);
      if (!(await this.fs.exists(absolutePath))) {
        removed.push(relPath);
        continue;
      }

      const stat = await this.fs.stat(absolutePath);
      const contentHash = stat.size > maxFileSizeBytes
        ? ''
        : this.hasher.hash(await this.fs.readText(absolutePath));
      const known = this.queries.getFile(relPath);

      if (known === undefined) {
        added.push(relPath);
        changedFiles.push(relPath);
      } else if (known.contentHash !== contentHash) {
        modified.push(relPath);
        changedFiles.push(relPath);
      }
    }

    const removedFiles = uniqueStrings(removed);
    const referrerFiles = this.findReferrerFilesForTargets(changedFiles);

    for (const relPath of removedFiles) {
      const priorNodeIds = this.queries.getNodesByFile(relPath).map((n) => n.id);
      const incomingEdges = this.findIncomingEdges(priorNodeIds);
      this.queries.deleteByFile(relPath);
      this.markIncomingEdgesUnresolved(incomingEdges);
    }

    if (changedFiles.length > 0 || removedFiles.length > 0) {
      const projectFiles = this.queries.getAllFiles()
        .map((file) => file.path)
        .filter((path) => !removedFiles.includes(path));
      for (const relPath of added) {
        if (!projectFiles.includes(relPath)) projectFiles.push(relPath);
      }
      projectFiles.sort(compareStrings);

      this.extractor.loadProject({
        rootPath: this.root,
        tsconfigPath: this.config.tsconfigPath,
        fileNames: projectFiles,
        loadNodesForFile: (filePath) => this.queries.getNodesByFile(filePath),
      });

      for (const relPath of changedFiles) {
        await this.indexFilePassA(relPath, { force: true });
      }

      for (const relPath of changedFiles) {
        this.indexFilePassB(relPath);
      }

      for (const relPath of referrerFiles) {
        this.indexFilePassB(relPath);
      }

      this.healUnresolvedEdges(changedFiles);
    }

    return {
      added: added.sort(compareStrings),
      modified: modified.sort(compareStrings),
      removed: removedFiles,
    };
  }

  close(): void {
    this.storage.close();
  }

  private async indexFilePassA(relPath: string, options: { force: boolean }): Promise<void> {
    const absolutePath = this.joinRoot(relPath);
    const stat = await this.fs.stat(absolutePath);
    const maxFileSizeBytes = this.config.maxFileSizeBytes ?? 2_000_000;

    if (stat.size > maxFileSizeBytes) {
      const error: ExtractionError = {
        message: `File exceeds maxFileSizeBytes (${maxFileSizeBytes})`,
        filePath: relPath,
        severity: 'warning',
        code: 'FILE_TOO_LARGE',
      };
      this.writeParsedFile(relPath, {
        contentHash: '',
        size: stat.size,
        modifiedAt: stat.modifiedAt,
        nodes: [],
        errors: [error],
      });
      return;
    }

    const source = await this.fs.readText(absolutePath);
    const contentHash = this.hasher.hash(source);
    const existing = this.queries.getFile(relPath);
    if (!options.force && existing?.contentHash === contentHash) return;

    const extraction = this.extractor.extractNodes(relPath, source);
    this.writeParsedFile(relPath, {
      contentHash,
      size: stat.size,
      modifiedAt: stat.modifiedAt,
      nodes: extraction.nodes,
      errors: extraction.errors,
    });
  }

  private indexFilePassB(relPath: string): void {
    const result = this.extractor.resolveEdges(relPath);

    const write = this.storage.transaction(() => {
      const fileNodes = this.queries.getNodesByFile(relPath);
      for (const node of fileNodes) {
        const nodeEdges = this.queries.getEdgesBySource(node.id);
        for (const edge of nodeEdges) {
          if (edge.id !== undefined) this.queries.deleteEdge(edge.id);
        }
      }

      for (const node of result.externalNodes) {
        this.queries.upsertNode(node);
      }

      for (const edge of result.edges) {
        this.queries.upsertEdge(edge);
      }

      const file = this.queries.getFile(relPath);
      if (file) {
        this.queries.upsertFile({ ...file, state: 'resolved' });
      }
    });

    write();
  }

  private healUnresolvedEdges(changedFiles: string[]): void {
    const newNodes = new Map<string, string>();
    for (const relPath of changedFiles) {
      for (const node of this.queries.getNodesByFile(relPath)) {
        newNodes.set(node.name, node.id);
      }
    }

    for (const [name, nodeId] of newNodes) {
      const unresolvedEdges = this.queries.getEdgesByResolutionStateAndTargetName('unresolved', name);
      for (const edge of unresolvedEdges) {
        if (edge.id !== undefined) {
          this.queries.upsertEdge({
            ...edge,
            target: nodeId,
            resolutionState: 'resolved',
            confidence: 'medium',
          });
        }
      }
    }
  }

  private findReferrerFilesForTargets(changedFiles: string[]): string[] {
    const changedNodeIds = new Set<string>();
    for (const relPath of changedFiles) {
      for (const node of this.queries.getNodesByFile(relPath)) {
        changedNodeIds.add(node.id);
      }
    }

    const referrerFiles = new Set<string>();
    for (const nodeId of changedNodeIds) {
      const incomingEdges = this.queries.getEdgesByTarget(nodeId);
      for (const edge of incomingEdges) {
        const sourceNode = this.queries.getNode(edge.source);
        if (sourceNode) {
          referrerFiles.add(sourceNode.filePath);
        }
      }
    }

    return [...referrerFiles].filter((f) => !changedFiles.includes(f));
  }

  private findIncomingEdges(targetNodeIds: string[]): ReturnType<QueryBuilder['getAllEdges']> {
    return targetNodeIds.flatMap((nodeId) => this.queries.getEdgesByTarget(nodeId));
  }

  private markIncomingEdgesUnresolved(incomingEdges: ReturnType<QueryBuilder['getAllEdges']>): void {
    for (const edge of incomingEdges) {
      if (this.queries.getNode(edge.source) === undefined) continue;
      const { id: _id, ...edgeWithoutId } = edge;
      this.queries.upsertEdge({
        ...edgeWithoutId,
        target: null,
        resolutionState: 'unresolved',
        confidence: 'low',
        targetName: edge.targetName ?? edge.target ?? undefined,
      });
    }
  }

  private writeParsedFile(
    relPath: string,
    input: {
      contentHash: string;
      size: number;
      modifiedAt: number;
      nodes: ReturnType<ProjectExtractor['extractNodes']>['nodes'];
      errors: ExtractionError[];
    },
  ): void {
    const write = this.storage.transaction(() => {
      this.queries.deleteByFile(relPath);
      for (const node of input.nodes) {
        this.queries.upsertNode(node);
      }

      const file: FileRecord = {
        path: relPath,
        project: 'root',
        contentHash: input.contentHash,
        language: languageFromPath(relPath),
        size: input.size,
        modifiedAt: input.modifiedAt,
        indexedAt: this.now(),
        nodeCount: input.nodes.length,
        state: 'parsed',
        errors: input.errors.length > 0 ? input.errors : undefined,
      };
      this.queries.upsertFile(file);
    });

    write();
  }

  private async scanFiles(): Promise<string[]> {
    const files: string[] = [];
    for await (const relPath of this.glob.scan(this.root, {
      include: this.config.include,
      exclude: this.config.exclude,
      gitignore: true,
    })) {
      files.push(normalizePath(relPath));
    }
    files.sort(compareStrings);
    return files;
  }

  private async computeConfigHash(): Promise<string> {
    const inputs = [
      this.config.tsconfigPath ?? 'tsconfig.json',
      'jsconfig.json',
      'package.json',
      'bun.lock',
      'bun.lockb',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      '.gitignore',
      '.astrograph/config.json',
    ];

    const parts = [`typescript:${ts.version}`];
    for (const relPath of inputs) {
      const absolutePath = this.joinRoot(relPath);
      if (!(await this.fs.exists(absolutePath))) continue;
      parts.push(`${relPath}\u001f${await this.fs.readText(absolutePath)}`);
    }

    return this.hasher.hash(parts.sort(compareStrings).join('\u001e'));
  }

  private persistProjectMetadata(configHash: string): void {
    const now = this.now();
    const write = this.storage.transaction(() => {
      this.upsertProjectMetadata('rootPath', this.root, now);
      this.upsertProjectMetadata('lastIndexedAt', String(now), now);
      this.upsertProjectMetadata('tsVersion', ts.version, now);
      this.upsertProjectMetadata('configHash', configHash, now);
    });
    write();
  }

  private getProjectMetadata(key: string): string | undefined {
    const row = this.storage.prepare('SELECT value FROM project_metadata WHERE key = ?').get(key) as
      | { value: string }
      | null
      | undefined;
    return row?.value;
  }

  private upsertProjectMetadata(key: string, value: string, updatedAt: number): void {
    this.storage.prepare(
      `INSERT INTO project_metadata (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value=excluded.value,
         updated_at=excluded.updated_at`,
    ).run(key, value, updatedAt);
  }

  private joinRoot(relPath: string): string {
    return `${this.root}/${relPath}`.replaceAll('//', '/');
  }
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/$/, '');
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function mergeEvents(events: WatchEvent[]): WatchEvent[] {
  const byPath = new Map<string, WatchEvent>();
  for (const event of events) {
    const path = normalizePath(event.path);
    const prior = byPath.get(path);
    if (prior === undefined || event.type === 'unlink' || prior.type === 'unlink') {
      byPath.set(path, { type: event.type, path });
    }
  }
  return [...byPath.values()].sort((a, b) => compareStrings(a.path, b.path));
}
