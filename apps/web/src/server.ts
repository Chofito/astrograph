import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openProject } from '@astrograph/core/bun';
import type { AstrographCore } from '@astrograph/core';
import indexHtml from './index.html';
import { handleGraph, handleStatus } from './api';

export interface ServeWebOptions {
  cwd: string;
  path?: string;
  port?: number;
  open?: boolean;
}

export async function serveWeb(opts: ServeWebOptions): Promise<void> {
  const startPath = resolve(opts.cwd, opts.path ?? '.');
  const root = findProjectRoot(startPath);
  if (root === undefined) {
    throw new WebServerError(
      `No Astrograph index found from ${startPath}. Run \`astrograph init\` first.`,
    );
  }

  const facade = await openProject(root);

  const port = opts.port ?? 3000;
  const hostname = '127.0.0.1';
  const url = `http://${hostname}:${port}`;

  Bun.serve({
    hostname,
    port,
    routes: {
      '/': indexHtml,
      '/api/graph': {
        GET: async (req) => {
          return handleGraph(facade, new URL(req.url));
        },
      },
      '/api/status': {
        GET: async () => {
          return handleStatus(facade);
        },
      },
    },
    error(error: Error) {
      return new Response(`<pre>${error.stack ?? error.message}</pre>`, {
        status: 500,
        headers: { 'content-type': 'text/html' },
      });
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Astrograph web server running at ${url}`);

  if (opts.open === true) {
    try {
      if (process.platform === 'darwin') {
        await Bun.$`open ${url}`;
      } else if (process.platform === 'linux') {
        await Bun.$`xdg-open ${url}`;
      }
    } catch {
      // Non-fatal: browser open is best-effort
    }
  }
}

export class WebServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebServerError';
  }
}

function findProjectRoot(startPath: string): string | undefined {
  let current = normalizeStart(startPath);
  while (true) {
    if (existsSync(`${current}/.astrograph`)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function normalizeStart(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return resolved;
  return statSync(resolved).isDirectory() ? resolved : dirname(resolved);
}
