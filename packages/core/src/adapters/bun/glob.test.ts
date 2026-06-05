import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { BunGlobScanner } from './glob';

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

describe('BunGlobScanner', () => {
  test('finds JS/TS files, honors ignores and yields sorted relative paths', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, '.gitignore', 'ignored.ts\nignored-dir/\n');
    await writeProjectFile(root, 'src/b.jsx', 'export const b = 1;');
    await writeProjectFile(root, 'src/a.ts', 'export const a = 1;');
    await writeProjectFile(root, 'src/c.mts', 'export const c = 1;');
    await writeProjectFile(root, 'src/readme.md', '# ignored');
    await writeProjectFile(root, 'ignored.ts', 'export const ignored = 1;');
    await writeProjectFile(root, 'ignored-dir/also.ts', 'export const ignored = 1;');
    await writeProjectFile(root, 'excluded/skip.ts', 'export const skip = 1;');
    await writeProjectFile(root, 'node_modules/pkg/index.ts', 'export const pkg = 1;');
    await writeProjectFile(root, '.astrograph/cache.ts', 'export const cache = 1;');
    await writeProjectFile(root, 'dist/out.ts', 'export const out = 1;');

    const scanner = new BunGlobScanner();
    const files: string[] = [];
    for await (const relPath of scanner.scan(root, { exclude: ['excluded/**'] })) {
      files.push(relPath);
    }

    expect(files).toEqual(['src/a.ts', 'src/b.jsx', 'src/c.mts']);
  });

  test('always excludes build dirs and yarn/pnpm committed artifacts', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/a.ts', 'export const a = 1;');
    await writeProjectFile(root, 'build/b.ts', 'export const b = 1;');
    await writeProjectFile(root, 'out/o.ts', 'export const o = 1;');
    await writeProjectFile(root, 'output/p.ts', 'export const p = 1;');
    await writeProjectFile(root, '.next/n.js', 'export const n = 1;');
    await writeProjectFile(root, '.pnp.cjs', 'module.exports = {};');
    await writeProjectFile(root, '.yarn/releases/yarn-4.0.0.cjs', 'module.exports = {};');

    const scanner = new BunGlobScanner();
    const files: string[] = [];
    for await (const relPath of scanner.scan(root, {})) {
      files.push(relPath);
    }

    expect(files).toEqual(['src/a.ts']);
  });
});

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/astrograph-glob-`);
  tempRoots.push(root);
  return root;
}

async function writeProjectFile(root: string, relPath: string, content: string): Promise<void> {
  const fullPath = `${root}/${relPath}`;
  const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, 'utf8');
}
