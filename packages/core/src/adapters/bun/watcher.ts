import { existsSync, watch } from 'node:fs';
import { resolve } from 'node:path';
import type { WatchEvent, Watcher } from '../../types';

export class BunWatcher implements Watcher {
  watch(paths: string[], onEvent: (e: WatchEvent) => void, opts: { debounceMs?: number } = {}): { close(): void } {
    const handles = paths.map((path) => {
      const root = normalizePath(resolve(path));
      const timers = new Map<string, ReturnType<typeof setTimeout>>();
      const debounceMs = opts.debounceMs ?? 0;
      const watcher = watch(root, { recursive: true }, (eventType, fileName) => {
        if (fileName === null) return;
        const eventPath = normalizePath(resolve(root, fileName.toString()));
        const event = classifyEvent(eventType, eventPath);
        const relEvent = { ...event, path: eventPath };
        if (debounceMs <= 0) {
          onEvent(relEvent);
          return;
        }
        const prior = timers.get(eventPath);
        if (prior !== undefined) clearTimeout(prior);
        timers.set(eventPath, setTimeout(() => {
          timers.delete(eventPath);
          onEvent(relEvent);
        }, debounceMs));
      });

      return {
        close() {
          for (const timer of timers.values()) clearTimeout(timer);
          timers.clear();
          watcher.close();
        },
      };
    });

    return {
      close() {
        for (const handle of handles) handle.close();
      },
    };
  }
}

function classifyEvent(eventType: string, path: string): WatchEvent {
  if (eventType === 'rename') {
    return { type: existsSync(path) ? 'add' : 'unlink', path };
  }
  return { type: 'change', path };
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('/private/var/') ? normalized.slice('/private'.length) : normalized;
}
