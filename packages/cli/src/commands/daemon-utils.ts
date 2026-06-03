import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'node:fs';
import { spawn } from 'bun';

export interface DaemonMetadata {
  pid: number;
  startedAt: number;
  root: string;
  mode: 'watch';
}

export function getDaemonMetadataPath(root: string): string {
  return `${root}/.astrograph/daemon.json`;
}

export function getDaemonLogPath(root: string): string {
  return `${root}/.astrograph/daemon.log`;
}

export function readDaemonMetadata(root: string): DaemonMetadata | undefined {
  const path = getDaemonMetadataPath(root);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DaemonMetadata;
  } catch {
    return undefined;
  }
}

export function writeDaemonMetadata(root: string, metadata: DaemonMetadata): void {
  const path = getDaemonMetadataPath(root);
  writeFileSync(path, JSON.stringify(metadata, null, 2), 'utf8');
}

export function removeDaemonMetadata(root: string): void {
  const path = getDaemonMetadataPath(root);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonRunning(root: string): boolean {
  const metadata = readDaemonMetadata(root);
  if (metadata === undefined) return false;
  if (!isPidAlive(metadata.pid)) {
    removeDaemonMetadata(root);
    return false;
  }
  return true;
}

export function peekDaemonRunning(root: string): boolean {
  const metadata = readDaemonMetadata(root);
  return metadata !== undefined && isPidAlive(metadata.pid);
}

export function spawnDaemon(root: string): DaemonMetadata {
  const logPath = getDaemonLogPath(root);
  const logFd = openSync(logPath, 'a');

  const proc = spawn(daemonCommand(root), {
    stdout: logFd,
    stderr: logFd,
    stdin: 'ignore',
  });

  proc.unref();

  const metadata: DaemonMetadata = {
    pid: proc.pid,
    startedAt: Date.now(),
    root,
    mode: 'watch',
  };

  writeDaemonMetadata(root, metadata);

  return metadata;
}

export async function stopDaemon(root: string): Promise<boolean> {
  const metadata = readDaemonMetadata(root);
  if (metadata === undefined) return false;

  if (!isPidAlive(metadata.pid)) {
    removeDaemonMetadata(root);
    return false;
  }

  try {
    process.kill(metadata.pid, 'SIGTERM');
    if (await waitForExit(metadata.pid, 1500)) {
      removeDaemonMetadata(root);
      return true;
    }
    process.kill(metadata.pid, 'SIGKILL');
    const stopped = await waitForExit(metadata.pid, 1000);
    if (stopped) removeDaemonMetadata(root);
    return stopped;
  } catch {
    removeDaemonMetadata(root);
    return false;
  }
}

function daemonCommand(root: string): string[] {
  const entry = process.argv[1];
  if (entry !== undefined && /\.(tsx?|jsx?|mjs|cjs)$/.test(entry)) {
    return [process.execPath, 'run', entry, 'daemon', '--path', root];
  }
  return [process.execPath, 'daemon', '--path', root];
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}
