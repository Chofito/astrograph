import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  getDaemonMetadataPath,
  getDaemonLogPath,
  readDaemonMetadata,
  writeDaemonMetadata,
  removeDaemonMetadata,
  isPidAlive,
  isDaemonRunning,
  type DaemonMetadata,
} from '../commands/daemon-utils';

describe('daemon-utils', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(`${tmpdir()}/astrograph-daemon-test-`);
    await mkdir(`${tempDir}/.astrograph`, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('getDaemonMetadataPath returns correct path', () => {
    expect(getDaemonMetadataPath('/project')).toBe('/project/.astrograph/daemon.json');
  });

  test('getDaemonLogPath returns correct path', () => {
    expect(getDaemonLogPath('/project')).toBe('/project/.astrograph/daemon.log');
  });

  test('writeDaemonMetadata and readDaemonMetadata round-trip', () => {
    const metadata: DaemonMetadata = {
      pid: 12345,
      startedAt: 1234567890,
      root: tempDir,
      mode: 'watch',
    };

    writeDaemonMetadata(tempDir, metadata);
    const read = readDaemonMetadata(tempDir);

    expect(read).toEqual(metadata);
  });

  test('readDaemonMetadata returns undefined when file does not exist', () => {
    expect(readDaemonMetadata(tempDir)).toBeUndefined();
  });

  test('removeDaemonMetadata removes the file', () => {
    const metadata: DaemonMetadata = {
      pid: 12345,
      startedAt: 1234567890,
      root: tempDir,
      mode: 'watch',
    };

    writeDaemonMetadata(tempDir, metadata);
    expect(readDaemonMetadata(tempDir)).toBeDefined();

    removeDaemonMetadata(tempDir);
    expect(readDaemonMetadata(tempDir)).toBeUndefined();
  });

  test('isPidAlive returns true for current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test('isPidAlive returns false for non-existent pid', () => {
    expect(isPidAlive(999999999)).toBe(false);
  });

  test('isDaemonRunning returns false when no metadata', () => {
    expect(isDaemonRunning(tempDir)).toBe(false);
  });

  test('isDaemonRunning returns true when pid is alive', () => {
    const metadata: DaemonMetadata = {
      pid: process.pid,
      startedAt: Date.now(),
      root: tempDir,
      mode: 'watch',
    };

    writeDaemonMetadata(tempDir, metadata);
    expect(isDaemonRunning(tempDir)).toBe(true);
  });

  test('isDaemonRunning returns false and cleans up when pid is dead', () => {
    const metadata: DaemonMetadata = {
      pid: 999999999,
      startedAt: Date.now(),
      root: tempDir,
      mode: 'watch',
    };

    writeDaemonMetadata(tempDir, metadata);
    expect(isDaemonRunning(tempDir)).toBe(false);
    expect(readDaemonMetadata(tempDir)).toBeUndefined();
  });
});
