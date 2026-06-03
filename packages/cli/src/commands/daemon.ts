import { FreshnessManager, type FreshnessSyncResult, type WatchEvent } from '@astrograph/core';
import { openProject } from '@astrograph/core/bun';
import { BunWatcher } from '@astrograph/core/bun';
import type { CliContext, CliRunResult } from '../cli';
import { ok } from '../cli';
import { stringValue, parseCommandArgs } from './parse';
import { loadConfig } from './shared';
import { requireProjectRoot, resolveProjectPath } from '../root';
import { removeDaemonMetadata } from './daemon-utils';
import { createInitReporter, formatInitReceipt, summaryFromStatus } from '../ui/init-reporter';

export async function runDaemon(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    path: { type: 'string', short: 'p' },
    help: { type: 'boolean', short: 'h' },
  });

  const root = requireProjectRoot(resolveProjectPath(ctx.cwd, stringValue(parsed.values, 'path')));
  const config = await loadConfig(root);
  const graph = await openProject(root, { config });

  const log = (msg: string) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${msg}`);
  };

  log('Daemon starting');

  try {
    await prepareIndex(root, graph, log);

    log('Starting watcher');
    const watcher = new BunWatcher();
    const freshness = new FreshnessManager({
      root,
      config,
      graph,
      watcher,
      debounceMs: config?.watchDebounceMs ?? 300,
      onSyncStart: (events) => {
        log(`Syncing ${formatEventBatch(events)}`);
      },
      onSyncComplete: (events, result) => {
        log(`Synced ${formatSyncResult(result)} from ${events.length} event(s)`);
      },
      onSyncError: (events, error) => {
        log(`Sync failed for ${events.length} event(s): ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    if (freshness.start()) {
      log('Watcher ready');
    } else {
      log('Watcher unavailable; run `astrograph sync` manually or restart the daemon after filesystem support is fixed');
    }

    const shutdown = async () => {
      log('Daemon shutting down');
      freshness.close();
      graph.close();
      removeDaemonMetadata(root);
      log('Daemon stopped');
      process.exit(0);
    };

    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());

    await new Promise(() => {});
  } catch (error) {
    log(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    removeDaemonMetadata(root);
    graph.close();
    process.exit(1);
  }

  return ok();
}

async function prepareIndex(
  root: string,
  graph: Awaited<ReturnType<typeof openProject>>,
  log: (msg: string) => void,
): Promise<void> {
  const stats = await graph.getStats({});
  const hasIndex = stats.data.fileCount > 0 || stats.data.coverage.total > 0;

  if (hasIndex) {
    log(`Existing index found: ${stats.data.fileCount} files, ${stats.data.nodeCount} symbols`);
    const result = await graph.sync();
    log(`Reconciled existing index: ${formatSyncResult(result)}`);
    return;
  }

  log(`Indexing ${root}`);
  const reporter = createInitReporter();
  try {
    reporter.start(root);
    await graph.indexAll({ onProgress: (progress) => reporter.progress(progress) });
    const freshStats = await graph.getStats({});
    reporter.done();
    log(formatInitReceipt(root, summaryFromStatus(freshStats.data)).replaceAll('\n', ' | '));
  } finally {
    reporter.close();
  }
}

function formatEventBatch(events: WatchEvent[]): string {
  const paths = events.map((event) => event.path).sort(compareStrings);
  const preview = paths.slice(0, 4).join(', ');
  const suffix = paths.length > 4 ? `, +${paths.length - 4} more` : '';
  return `${events.length} changed file(s): ${preview}${suffix}`;
}

function formatSyncResult(result: FreshnessSyncResult): string {
  const changed = result.added.length + result.modified.length + result.removed.length;
  if (changed === 0) return 'no index changes';
  return `+${result.added.length} ~${result.modified.length} -${result.removed.length}`;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
