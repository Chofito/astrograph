import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openProject } from '@astrograph/core/bun';
import type { Astrograph } from '@astrograph/core';
import { handleGraph, handleStatus } from './api';

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

describe('api handlers', () => {
  test('handleStatus returns JSON with stats shape', async () => {
    const graph = await createFixtureGraph();
    try {
      const response = await handleStatus(graph);
      const body = (await response.json()) as { data: { nodeCount: number }; meta: { coverage: { total: number } } };
      expect(typeof body.data.nodeCount).toBe('number');
      expect(typeof body.meta.coverage.total).toBe('number');
    } finally {
      graph.close();
    }
  });

  test('handleGraph returns nodes and edges with default external exclusion', async () => {
    const graph = await createFixtureGraph();
    try {
      const url = new URL('http://localhost/api/graph');
      const response = await handleGraph(graph, url);
      const body = (await response.json()) as { data: { nodes: unknown[]; edges: unknown[] }; meta: { partial: boolean } };
      expect(Array.isArray(body.data.nodes)).toBe(true);
      expect(Array.isArray(body.data.edges)).toBe(true);
      expect(body.meta.partial).toBe(false);
    } finally {
      graph.close();
    }
  });

  test('handleGraph respects limit param', async () => {
    const graph = await createFixtureGraph();
    try {
      const url = new URL('http://localhost/api/graph?limit=2');
      const response = await handleGraph(graph, url);
      const body = (await response.json()) as { data: { nodes: unknown[]; edges: unknown[] } };
      expect(body.data.nodes.length).toBeLessThanOrEqual(2);
    } finally {
      graph.close();
    }
  });
});

async function createFixtureGraph(): Promise<Astrograph> {
  const root = await mkdtemp(`${tmpdir()}/astrograph-web-api-`);
  tempRoots.push(root);

  await mkdir(`${root}/src`, { recursive: true });
  await writeFile(`${root}/tsconfig.json`, JSON.stringify({
    compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', strict: true },
    include: ['src/**/*.ts'],
  }), 'utf8');
  await writeFile(`${root}/src/a.ts`, [
    'export function hello() {',
    "  return 'world';",
    '}',
    '',
  ].join('\n'), 'utf8');
  await writeFile(`${root}/src/b.ts`, [
    "import { hello } from './a';",
    'export function caller() {',
    '  return hello();',
    '}',
    '',
  ].join('\n'), 'utf8');

  const graph = await openProject(root, { dbPath: ':memory:', now: () => 100 });
  await graph.indexAll();
  return graph;
}
