import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openProject } from '@astrograph/core/bun';
import type { CliContext, CliRunResult } from '../cli';
import { CliError, ok } from '../cli';
import { booleanValue, parseCommandArgs } from './parse';
import { loadConfig } from './shared';
import { style, symbols } from '../format/style';
import { isDaemonRunning, readDaemonMetadata, spawnDaemon } from './daemon-utils';
import { createInitReporter, formatInitReceipt, summaryFromStatus } from '../ui/init-reporter';

export async function runInit(args: string[], ctx: CliContext): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    'no-index': { type: 'boolean' },
    detached: { type: 'boolean', short: 'd' },
    yes: { type: 'boolean', short: 'y' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  });
  const root = resolve(ctx.cwd, parsed.positionals[0] ?? '.');
  await mkdir(`${root}/.astrograph`, { recursive: true });

  if (booleanValue(parsed.values, 'no-index')) {
    return ok(style.success(`Initialized ${style.path(root)}`));
  }

  if (booleanValue(parsed.values, 'detached')) {
    if (isDaemonRunning(root)) {
      const metadata = readDaemonMetadata(root);
      return ok(style.info(`Daemon already running (pid ${metadata?.pid ?? 'unknown'})`));
    }

    const metadata = spawnDaemon(root);
    const lines = [
      style.success('Astrograph started in background'),
      `  indexing ${style.path(root)} ${symbols.bullet} watcher starts after initial index`,
      `  pid ${style.num(metadata.pid)} ${symbols.bullet} logs: ${style.path('.astrograph/daemon.log')}`,
    ];
    return ok(lines.join('\n'));
  }

  if (isDaemonRunning(root)) {
    const metadata = readDaemonMetadata(root);
    throw new CliError(
      `Cannot init: daemon is running (pid ${metadata?.pid ?? 'unknown'}). Stop it first with \`astrograph stop\`.`,
      1,
    );
  }

  const graph = await openProject(root, { config: await loadConfig(root) });
  const reporter = createInitReporter();
  try {
    reporter.start(root);
    await graph.indexAll({ onProgress: (event) => reporter.progress(event) });
    const stats = await graph.getStats({});
    const summary = summaryFromStatus(stats.data);
    reporter.done();
    return ok(formatInitReceipt(root, summary));
  } finally {
    reporter.close();
    graph.close();
  }
}
