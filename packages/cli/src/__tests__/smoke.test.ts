import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runCallees } from '../commands/callees';
import { runInit } from '../commands/init';
import { runSearch } from '../commands/search';
import { runStatus } from '../commands/status';

describe('CLI command smoke', () => {
  test('init then search/status produce rows and exit 0', async () => {
    const root = await mkdtemp(`${tmpdir()}/astrograph-cli-smoke-`);
    try {
      await mkdir(`${root}/src`, { recursive: true });
      await writeFile(`${root}/src/a.ts`, [
        'export function helper() {',
        "  return 'ok';",
        '}',
        '',
      ].join('\n'), 'utf8');

      const init = await runInit([root], { cwd: root });
      expect(init.exitCode).toBe(0);

      const search = await runSearch(['helper', '-p', root], { cwd: root });
      expect(search.exitCode).toBe(0);
      expect(search.stdout).toContain('function helper  src/a.ts:1');
      expect(search.stdout).toContain('partial: no');

      const status = await runStatus([root], { cwd: root });
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain('files');
      expect(status.stdout).toContain('1');
      expect(status.stdout).toContain('coverage');
      expect(status.stdout).toContain('1/1 resolved');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('callees hides external symbols by default and includes them with the flag', async () => {
    const root = await mkdtemp(`${tmpdir()}/astrograph-cli-external-`);
    try {
      await mkdir(`${root}/src`, { recursive: true });
      await mkdir(`${root}/node_modules/fake-lib`, { recursive: true });
      await writeFile(`${root}/tsconfig.json`, [
        '{',
        '  "compilerOptions": {',
        '    "target": "ESNext",',
        '    "module": "ESNext",',
        '    "moduleResolution": "bundler",',
        '    "skipLibCheck": true,',
        '    "strict": true',
        '  },',
        '  "include": ["src/**/*.ts"]',
        '}',
        '',
      ].join('\n'), 'utf8');
      await writeFile(`${root}/node_modules/fake-lib/index.d.ts`, [
        'export declare function externalFn(): string;',
        '',
      ].join('\n'), 'utf8');
      await writeFile(`${root}/node_modules/fake-lib/package.json`, [
        '{ "name": "fake-lib", "main": "index.js", "types": "index.d.ts" }',
        '',
      ].join('\n'), 'utf8');
      await writeFile(`${root}/src/a.ts`, [
        "import { externalFn } from 'fake-lib';",
        '',
        'export function helper() {',
        "  return 'ok';",
        '}',
        '',
        'export function run() {',
        '  return helper() + externalFn();',
        '}',
        '',
      ].join('\n'), 'utf8');

      const init = await runInit([root], { cwd: root });
      expect(init.exitCode).toBe(0);

      const defaultCallees = await runCallees(['run', '-p', root], { cwd: root });
      expect(defaultCallees.exitCode).toBe(0);
      expect(defaultCallees.stdout).toContain('function helper  src/a.ts:3');
      expect(defaultCallees.stdout).not.toContain('externalFn');

      const withExternal = await runCallees(['run', '-p', root, '--include-external'], { cwd: root });
      expect(withExternal.exitCode).toBe(0);
      expect(withExternal.stdout).toContain('function helper  src/a.ts:3');
      expect(withExternal.stdout).toContain('function externalFn  node_modules/fake-lib/index.d.ts:0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
