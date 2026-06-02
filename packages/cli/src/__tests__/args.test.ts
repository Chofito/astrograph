import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runCli } from '../cli';

describe('CLI argument dispatch', () => {
  test('unknown command exits 1 with usage', async () => {
    const result = await runCli(['nope'], { cwd: process.cwd() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown command: nope');
    expect(result.stderr).toContain('Usage: astrograph');
  });

  test('command help exits 0', async () => {
    const result = await runCli(['search', '--help'], { cwd: process.cwd() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('astrograph search <query>');
  });

  test('query command without an index exits 2 with init hint', async () => {
    const root = await mkdtemp(`${tmpdir()}/astrograph-cli-no-index-`);
    try {
      const result = await runCli(['q', 'helper'], { cwd: root });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Run `astrograph init` first');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
