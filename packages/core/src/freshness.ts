import type { AstrographConfig, AstrographCore, ToolResult, WatchEvent, Watcher } from './types';

export interface FreshnessSyncResult {
  added: string[];
  modified: string[];
  removed: string[];
}

export interface FreshnessManagerOptions {
  root: string;
  config?: AstrographConfig;
  graph: AstrographCore;
  watcher?: Watcher;
  debounceMs?: number;
  onSyncStart?: (events: WatchEvent[]) => void;
  onSyncComplete?: (events: WatchEvent[], result: FreshnessSyncResult) => void;
  onSyncError?: (events: WatchEvent[], error: unknown) => void;
}

export class FreshnessManager {
  private readonly root: string;
  private readonly graph: AstrographCore;
  private readonly watcher: Watcher | undefined;
  private readonly debounceMs: number;
  private readonly excludedPrefixes: string[];
  private readonly onSyncStart: ((events: WatchEvent[]) => void) | undefined;
  private readonly onSyncComplete: ((events: WatchEvent[], result: FreshnessSyncResult) => void) | undefined;
  private readonly onSyncError: ((events: WatchEvent[], error: unknown) => void) | undefined;

  private readonly pendingEvents = new Map<string, WatchEvent>();
  private watchHandle: { close(): void } | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private syncQueue: Promise<void> = Promise.resolve();
  private unavailable = false;
  private closed = false;

  constructor(options: FreshnessManagerOptions) {
    this.root = normalizePath(options.root);
    this.graph = options.graph;
    this.watcher = options.watcher;
    this.debounceMs = options.debounceMs ?? options.config?.watchDebounceMs ?? 300;
    this.onSyncStart = options.onSyncStart;
    this.onSyncComplete = options.onSyncComplete;
    this.onSyncError = options.onSyncError;
    this.excludedPrefixes = [
      'node_modules/',
      '.git/',
      '.astrograph/',
      'dist/',
      ...(options.config?.exclude ?? []),
    ].map(normalizeExclude);
  }

  start(): boolean {
    if (this.closed || this.watcher === undefined) return false;
    try {
      this.watchHandle = this.watcher.watch([this.root], (event) => this.recordEvent(event));
      return true;
    } catch {
      this.unavailable = true;
      return false;
    }
  }

  async beforeQuery(): Promise<void> {
    if (this.pendingEvents.size === 0) {
      await this.syncQueue;
      return;
    }
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    await this.flushPending();
  }

  decorateResult<T>(result: ToolResult<T>): ToolResult<T> {
    const pendingFiles = this.pendingFiles();
    if (pendingFiles.length === 0 && !this.unavailable) return result;

    const notes = [...(result.meta.notes ?? [])];
    if (this.unavailable) {
      notes.push('watcher unavailable; freshness depends on explicit sync or pending events');
    }

    return {
      data: result.data,
      meta: {
        ...result.meta,
        partial: result.meta.partial || pendingFiles.length > 0 || this.unavailable,
        pendingFiles: uniqueSorted([...(result.meta.pendingFiles ?? []), ...pendingFiles]),
        notes: notes.length > 0 ? notes : undefined,
      },
    };
  }

  pendingFiles(): string[] {
    return uniqueSorted([...this.pendingEvents.keys()]);
  }

  recordEvent(event: WatchEvent): void {
    if (this.closed) return;
    const relPath = this.toProjectPath(event.path);
    if (!this.isSourcePath(relPath)) return;
    const normalizedEvent: WatchEvent = { type: event.type, path: relPath };
    this.pendingEvents.set(relPath, mergeEvent(this.pendingEvents.get(relPath), normalizedEvent));
    this.scheduleBackgroundSync();
  }

  markUnavailable(): void {
    this.unavailable = true;
  }

  close(): void {
    this.closed = true;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.watchHandle?.close();
    this.watchHandle = undefined;
  }

  private scheduleBackgroundSync(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.flushPending().catch(() => {});
    }, this.debounceMs);
  }

  private async flushPending(): Promise<void> {
    const events = this.drainPending();
    if (events.length === 0) return;

    await this.enqueueSync(async () => {
      this.onSyncStart?.(events);
      try {
        const result = await this.graph.syncFiles(events);
        this.onSyncComplete?.(events, result);
      } catch (error) {
        for (const event of events) this.pendingEvents.set(event.path, event);
        this.onSyncError?.(events, error);
        throw error;
      }
    });
  }

  private enqueueSync(fn: () => Promise<void>): Promise<void> {
    const run = this.syncQueue.then(fn, fn);
    this.syncQueue = run.catch(() => {});
    return run;
  }

  private drainPending(): WatchEvent[] {
    const events = [...this.pendingEvents.values()].sort((a, b) => compareStrings(a.path, b.path));
    this.pendingEvents.clear();
    return events;
  }

  private toProjectPath(path: string): string {
    const normalized = normalizePath(path);
    if (normalized.startsWith(this.root + '/')) return normalized.slice(this.root.length + 1);
    return normalized.replace(/^\.\//, '');
  }

  private isSourcePath(path: string): boolean {
    if (!/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/.test(path)) return false;
    return !this.excludedPrefixes.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
  }
}

function mergeEvent(prior: WatchEvent | undefined, next: WatchEvent): WatchEvent {
  if (prior === undefined) return next;
  if (next.type === 'unlink') return next;
  if (prior.type === 'unlink') return next;
  if (prior.type === 'add') return prior;
  return next;
}

function normalizeExclude(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  return normalized.startsWith('/private/var/') ? normalized.slice('/private'.length) : normalized;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
