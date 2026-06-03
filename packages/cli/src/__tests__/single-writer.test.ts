import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runCli } from '../cli';
import { writeDaemonMetadata, type DaemonMetadata } from '../commands/daemon-utils';

describe('single-writer detection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(`${tmpdir()}/astrograph-single-writer-test-`);
    await mkdir(`${tempDir}/.astrograph`, { recursive: true });
    await mkdir(`${tempDir}/src`, { recursive: true });
    await writeFile(`${tempDir}/src/a.ts`, 'export function foo() { return 1; }\n', 'utf8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('init command fails when daemon is running', async () => {
    const metadata: DaemonMetadata = {
      pid: process.pid,
      startedAt: Date.now(),
      root: tempDir,
      mode: 'watch',
    };
    writeDaemonMetadata(tempDir, metadata);

    const result = await runCli(['init', tempDir], { cwd: tempDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('daemon is running');
    expect(result.stderr).toContain('astrograph stop');
  });

  test('index command fails when daemon is running', async () => {
    const init = await runCli(['init', tempDir], { cwd: tempDir });
    expect(init.exitCode).toBe(0);

    const metadata: DaemonMetadata = {
      pid: process.pid,
      startedAt: Date.now(),
      root: tempDir,
      mode: 'watch',
    };
    writeDaemonMetadata(tempDir, metadata);

    const result = await runCli(['index', tempDir], { cwd: tempDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('daemon is running');
    expect(result.stderr).toContain('astrograph stop');
  });

  test('sync command fails when daemon is running', async () => {
    const init = await runCli(['init', tempDir], { cwd: tempDir });
    expect(init.exitCode).toBe(0);

    const metadata: DaemonMetadata = {
      pid: process.pid,
      startedAt: Date.now(),
      root: tempDir,
      mode: 'watch',
    };
    writeDaemonMetadata(tempDir, metadata);

    const result = await runCli(['sync', tempDir], { cwd: tempDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('daemon is running');
    expect(result.stderr).toContain('astrograph stop');
  });
});
