import { existsSync, readFileSync } from 'node:fs';

export interface DaemonMetadata {
  pid: number;
  startedAt: number;
  root: string;
  mode: 'watch';
}

export function readActiveDaemon(root: string): DaemonMetadata | undefined {
  const path = `${root}/.astrograph/daemon.json`;
  if (!existsSync(path)) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(path, 'utf8')) as Partial<DaemonMetadata>;
    if (typeof metadata.pid !== 'number') return undefined;
    if (typeof metadata.startedAt !== 'number') return undefined;
    if (typeof metadata.root !== 'string') return undefined;
    if (metadata.mode !== 'watch') return undefined;
    const daemon: DaemonMetadata = {
      pid: metadata.pid,
      startedAt: metadata.startedAt,
      root: metadata.root,
      mode: metadata.mode,
    };
    return isPidAlive(daemon.pid) ? daemon : undefined;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
