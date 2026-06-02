import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
      expect(status.stdout).toContain('files 1');
      expect(status.stdout).toContain('coverage 1/1 resolved');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
