import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openProject } from './adapters/bun/project';

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

describe('Indexer', () => {
  test('indexAll populates nodes and parsed file coverage', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/user.ts', `
      export function greet(name: string) {
        return 'hello ' + name;
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const files = indexer.queries.getAllFiles();
      expect(files.map((file) => [file.path, file.state])).toEqual([['src/user.ts', 'resolved']]);
      expect(indexer.queries.search({ query: 'greet' }).map((result) => result.node.name)).toEqual(['greet']);
      expect(indexer.queries.getStats().coverage).toEqual({
        total: 1,
        resolved: 1,
        parsed: 0,
        pending: 0,
      });
    } finally {
      indexer.close();
    }
  });

  test('sync reports sorted added, modified, and removed files without dangling edges', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/a.ts', 'export function a() { return 1; }');
    await writeProjectFile(root, 'src/remove.ts', 'export function removeMe() { return 1; }');

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      await writeProjectFile(root, 'src/a.ts', 'export function a() { return 2; }');
      await writeProjectFile(root, 'src/b.ts', 'export function b() { return 3; }');
      await unlink(`${root}/src/remove.ts`);

      const result = await indexer.sync();

      expect(result).toEqual({
        added: ['src/b.ts'],
        modified: ['src/a.ts'],
        removed: ['src/remove.ts'],
      });
      expect(indexer.queries.getFile('src/remove.ts')).toBeUndefined();
      expect(indexer.queries.getDanglingEdges()).toEqual([]);
    } finally {
      indexer.close();
    }
  });

  test('indexAll is deterministic over repeated indexes of the same project', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/a.ts', `
      export class A {
        run() {
          return 1;
        }
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll({ force: true });
      const firstIds = indexer.queries.getAllNodes().map((node) => node.id);

      await indexer.indexAll({ force: true });
      const secondIds = indexer.queries.getAllNodes().map((node) => node.id);

      expect(secondIds).toEqual(firstIds);
    } finally {
      indexer.close();
    }
  });
});

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/astrograph-indexer-`);
  tempRoots.push(root);
  return root;
}

async function writeProjectFile(root: string, relPath: string, content: string): Promise<void> {
  const fullPath = `${root}/${relPath}`;
  const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, 'utf8');
}
