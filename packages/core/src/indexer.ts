import ts from 'typescript';
import type {
  AstrographConfig,
  ExtractionError,
  Extractor,
  FileRecord,
  FileSystem,
  GlobScanner,
  Hasher,
  StorageAdapter,
} from './types';
import { QueryBuilder } from './db/queries';
import { languageFromPath } from './extraction/language';

export interface IndexerOptions {
  queries: QueryBuilder;
  storage: StorageAdapter;
  fs: FileSystem;
  hasher: Hasher;
  glob: GlobScanner;
  extractor: Extractor;
  config?: AstrographConfig;
  root: string;
  now?: () => number;
}

export interface IndexAllOptions {
  force?: boolean;
}

export class Indexer {
  readonly queries: QueryBuilder;

  private readonly storage: StorageAdapter;
  private readonly fs: FileSystem;
  private readonly hasher: Hasher;
  private readonly glob: GlobScanner;
  private readonly extractor: Extractor;
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

    for (const relPath of files) {
      await this.indexFile(relPath, { force: options.force ?? false });
    }

    this.persistProjectMetadata(configHash);
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

    for (const relPath of [...added, ...modified]) {
      await this.indexFile(relPath, { force: true });
    }

    for (const relPath of removed) {
      this.queries.deleteByFile(relPath);
    }

    this.persistProjectMetadata(configHash);

    return {
      added: added.sort(compareStrings),
      modified: modified.sort(compareStrings),
      removed: removed.sort(compareStrings),
    };
  }

  close(): void {
    this.storage.close();
  }

  private async indexFile(relPath: string, options: { force: boolean }): Promise<void> {
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
    // TODO(pass-b): resolve edges for this file, then mark state 'resolved'.
  }

  private writeParsedFile(
    relPath: string,
    input: {
      contentHash: string;
      size: number;
      modifiedAt: number;
      nodes: ReturnType<Extractor['extractNodes']>['nodes'];
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
