import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc } from 'jsonc-parser';
import { runCli } from '../cli';
import { runInstallCore } from '../commands/install';
import { runUninstallCore } from '../commands/uninstall';

// Each test gets its own fake home dir injected via homeDir param.
// No real ~/.claude.json or other user files are touched.

async function makeTmpHome(): Promise<{ root: string; cwd: string; homeDir: string }> {
  const root = await mkdtemp(`${tmpdir()}/astrograph-install-`);
  const homeDir = join(root, 'home');
  const cwd = join(root, 'project');
  await mkdir(homeDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { root, cwd, homeDir };
}

const DEFAULT_ARGS = ['--yes'];
const ctx = (cwd: string) => ({ cwd });

async function expectGuideInstalled(path: string, source: 'directory' | 'file'): Promise<void> {
  const guidePath = source === 'directory' ? join(path, 'SKILL.md') : path;
  expect(existsSync(guidePath)).toBe(true);
  const text = await readFile(guidePath, 'utf8');
  expect(text).toContain('name: astrograph');
}

// ---------------------------------------------------------------------------
// Claude target (JSON, global ~/.claude.json / local ./.mcp.json)
// ---------------------------------------------------------------------------

describe('claude target', () => {
  test('install into missing global file creates it with correct shape', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const result = await runInstallCore(['--target', 'claude', '--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);

      const filePath = join(homeDir, '.claude.json');
      expect(existsSync(filePath)).toBe(true);
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      expect(parsed.mcpServers.astrograph).toEqual({
        type: 'stdio',
        command: 'astrograph',
        args: ['serve', '--mcp'],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('install writes the Claude Code skill', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const result = await runInstallCore(['--target', 'claude', '--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);
      await expectGuideInstalled(join(homeDir, '.claude', 'skills', 'astrograph'), 'directory');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('install into local path writes to .mcp.json', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const result = await runInstallCore(['--target', 'claude', '--location', 'local', '--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(cwd, '.mcp.json'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('install preserves existing mcpServers and other keys', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const existing = {
        someOtherKey: 'preserved',
        mcpServers: {
          otherServer: { type: 'stdio', command: 'other', args: [] },
        },
      };
      const filePath = join(homeDir, '.claude.json');
      await writeFile(filePath, JSON.stringify(existing, null, 2), 'utf8');

      await runInstallCore(['--target', 'claude', '--yes'], ctx(cwd), homeDir);

      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      expect(parsed.someOtherKey).toBe('preserved');
      expect(parsed.mcpServers.otherServer).toEqual({ type: 'stdio', command: 'other', args: [] });
      expect(parsed.mcpServers.astrograph).toEqual({
        type: 'stdio',
        command: 'astrograph',
        args: ['serve', '--mcp'],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('install twice is idempotent', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      await runInstallCore(['--target', 'claude', '--yes'], ctx(cwd), homeDir);
      const result2 = await runInstallCore(['--target', 'claude', '--yes'], ctx(cwd), homeDir);
      expect(result2.exitCode).toBe(0);
      expect(result2.stdout).toContain('already configured');

      const parsed = JSON.parse(await readFile(join(homeDir, '.claude.json'), 'utf8'));
      const servers = Object.keys(parsed.mcpServers);
      expect(servers.filter((k) => k === 'astrograph').length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uninstall removes only astrograph and leaves the rest', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const existing = {
        topLevel: true,
        mcpServers: {
          otherServer: { type: 'stdio', command: 'other', args: [] },
          astrograph: { type: 'stdio', command: 'astrograph', args: ['serve', '--mcp'] },
        },
      };
      const filePath = join(homeDir, '.claude.json');
      await writeFile(filePath, JSON.stringify(existing, null, 2), 'utf8');

      const result = await runUninstallCore(['--target', 'claude', '--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('removed');

      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      expect(parsed.topLevel).toBe(true);
      expect(parsed.mcpServers.otherServer).toBeDefined();
      expect(parsed.mcpServers.astrograph).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uninstall removes the Claude Code skill', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      await runInstallCore(['--target', 'claude', '--yes'], ctx(cwd), homeDir);
      const skillPath = join(homeDir, '.claude', 'skills', 'astrograph');
      await expectGuideInstalled(skillPath, 'directory');

      const result = await runUninstallCore(['--target', 'claude', '--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);
      expect(existsSync(skillPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uninstall when not configured is a clean no-op', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const result = await runUninstallCore(['--target', 'claude', '--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('not configured');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('--print-config prints entry and writes nothing', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const filePath = join(homeDir, '.claude.json');
      const result = await runInstallCore(['--print-config', 'claude'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"astrograph"');
      expect(result.stdout).toContain('"stdio"');
      expect(existsSync(filePath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('install creates .bak backup for global ~/.claude.json', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const filePath = join(homeDir, '.claude.json');
      await writeFile(filePath, JSON.stringify({ existing: true }), 'utf8');

      await runInstallCore(['--target', 'claude', '--yes'], ctx(cwd), homeDir);
      expect(existsSync(`${filePath}.bak`)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cursor target (JSON, same mcpServers shape)
// ---------------------------------------------------------------------------

describe('cursor target', () => {
  test('install into missing global file creates it', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const result = await runInstallCore(['--target', 'cursor', '--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);

      const filePath = join(homeDir, '.cursor', 'mcp.json');
      expect(existsSync(filePath)).toBe(true);
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      expect(parsed.mcpServers.astrograph).toEqual({
        type: 'stdio',
        command: 'astrograph',
        args: ['serve', '--mcp'],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('local install writes the Cursor rule', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const result = await runInstallCore(['--target', 'cursor', '--location', 'local', '--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);
      await expectGuideInstalled(join(cwd, '.cursor', 'rules', 'astrograph.mdc'), 'file');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('install preserves other servers', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const filePath = join(homeDir, '.cursor', 'mcp.json');
      await mkdir(join(homeDir, '.cursor'), { recursive: true });
      await writeFile(filePath, JSON.stringify({ mcpServers: { existing: { command: 'x' } } }), 'utf8');

      await runInstallCore(['--target', 'cursor', '--yes'], ctx(cwd), homeDir);

      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      expect(parsed.mcpServers.existing).toBeDefined();
      expect(parsed.mcpServers.astrograph).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('install twice is idempotent', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      await runInstallCore(['--target', 'cursor', '--yes'], ctx(cwd), homeDir);
      const r2 = await runInstallCore(['--target', 'cursor', '--yes'], ctx(cwd), homeDir);
      expect(r2.stdout).toContain('already configured');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uninstall removes only astrograph', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const filePath = join(homeDir, '.cursor', 'mcp.json');
      await mkdir(join(homeDir, '.cursor'), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({ mcpServers: { other: { command: 'x' }, astrograph: { command: 'astrograph' } } }),
        'utf8',
      );

      await runUninstallCore(['--target', 'cursor', '--yes'], ctx(cwd), homeDir);

      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      expect(parsed.mcpServers.other).toBeDefined();
      expect(parsed.mcpServers.astrograph).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uninstall when absent is a no-op', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const r = await runUninstallCore(['--target', 'cursor', '--yes'], ctx(cwd), homeDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('not configured');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Codex target (TOML, global only)
// ---------------------------------------------------------------------------

describe('codex target', () => {
  test('install into missing global file creates it with correct TOML shape', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const result = await runInstallCore(['--target', 'codex', '--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);

      const filePath = join(homeDir, '.codex', 'config.toml');
      expect(existsSync(filePath)).toBe(true);
      const text = await readFile(filePath, 'utf8');
      const parsed = parseToml(text) as any;
      expect(parsed.mcp_servers.astrograph).toEqual({
        command: 'astrograph',
        args: ['serve', '--mcp'],
      });
      // Also verify the TOML string shape contains a table header
      expect(text).toContain('[mcp_servers.astrograph]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('install writes the Codex skill', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const result = await runInstallCore(['--target', 'codex', '--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);
      await expectGuideInstalled(join(homeDir, '.codex', 'skills', 'astrograph'), 'directory');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('install preserves other tables', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const filePath = join(homeDir, '.codex', 'config.toml');
      await mkdir(join(homeDir, '.codex'), { recursive: true });
      await writeFile(filePath, 'model = "gpt-4"\n\n[mcp_servers.other]\ncommand = "x"\n', 'utf8');

      await runInstallCore(['--target', 'codex', '--yes'], ctx(cwd), homeDir);

      const text = await readFile(filePath, 'utf8');
      const parsed = parseToml(text) as any;
      expect(parsed.model).toBe('gpt-4');
      expect(parsed.mcp_servers.other.command).toBe('x');
      expect(parsed.mcp_servers.astrograph.command).toBe('astrograph');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('install twice is idempotent', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      await runInstallCore(['--target', 'codex', '--yes'], ctx(cwd), homeDir);
      const r2 = await runInstallCore(['--target', 'codex', '--yes'], ctx(cwd), homeDir);
      expect(r2.stdout).toContain('already configured');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uninstall removes only astrograph and leaves other tables', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const filePath = join(homeDir, '.codex', 'config.toml');
      await mkdir(join(homeDir, '.codex'), { recursive: true });
      await writeFile(
        filePath,
        'model = "gpt-4"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.astrograph]\ncommand = "astrograph"\nargs = ["serve", "--mcp"]\n',
        'utf8',
      );

      await runUninstallCore(['--target', 'codex', '--yes'], ctx(cwd), homeDir);

      const parsed = parseToml(await readFile(filePath, 'utf8')) as any;
      expect(parsed.model).toBe('gpt-4');
      expect(parsed.mcp_servers.other).toBeDefined();
      expect(parsed.mcp_servers.astrograph).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uninstall when absent is a no-op', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const r = await runUninstallCore(['--target', 'codex', '--yes'], ctx(cwd), homeDir);
      expect(r.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('--location local warns and skips codex', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      const result = await runInstallCore(['--target', 'codex', '--location', 'local', '--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);
      // Nothing written — codex global-only
      expect(existsSync(join(homeDir, '.codex', 'config.toml'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// opencode target (JSONC, comment-preserving)
// XDG_CONFIG_HOME is temporarily set per-test so tests never touch real paths.
// Tests within a file run serially in Bun so env mutation is safe.
// ---------------------------------------------------------------------------

describe('opencode target', () => {
  // Wrap a test body: sets XDG_CONFIG_HOME → homeDir/.config so configPath
  // resolves into the temp tree regardless of the real env.
  async function withXdgTmp(
    fn: (params: { root: string; cwd: string; homeDir: string; filePath: string }) => Promise<void>,
  ): Promise<void> {
    const { root, cwd, homeDir } = await makeTmpHome();
    const xdgBase = join(homeDir, '.config');
    const filePath = join(xdgBase, 'opencode', 'opencode.jsonc');
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgBase;
    try {
      await fn({ root, cwd, homeDir, filePath });
    } finally {
      if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
      else delete process.env.XDG_CONFIG_HOME;
      await rm(root, { recursive: true, force: true });
    }
  }

  test('install into missing global file creates it with correct shape', () =>
    withXdgTmp(async ({ cwd, homeDir, filePath }) => {
      const result = await runInstallCore(['--target', 'opencode', '--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);
      expect(existsSync(filePath)).toBe(true);
      const parsed = parseJsonc(await readFile(filePath, 'utf8')) as any;
      expect(parsed.mcp.astrograph).toEqual({
        type: 'local',
        command: ['astrograph', 'serve', '--mcp'],
        enabled: true,
      });
    }));

  test('install does not overwrite an existing opencode AGENTS.md', () =>
    withXdgTmp(async ({ cwd, homeDir }) => {
      const agentsPath = join(homeDir, '.config', 'opencode', 'AGENTS.md');
      await mkdir(dirname(agentsPath), { recursive: true });
      await writeFile(agentsPath, 'keep me\n', 'utf8');

      const result = await runInstallCore(['--target', 'opencode', '--yes'], ctx(cwd), homeDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('agent guide skipped');
      expect(await readFile(agentsPath, 'utf8')).toBe('keep me\n');
    }));

  test('install into local path writes to ./opencode.jsonc', () =>
    withXdgTmp(async ({ cwd, homeDir }) => {
      await runInstallCore(['--target', 'opencode', '--location', 'local', '--yes'], ctx(cwd), homeDir);
      expect(existsSync(join(cwd, 'opencode.jsonc'))).toBe(true);
    }));

  test('install with existing JSONC that has comments preserves comments', () =>
    withXdgTmp(async ({ cwd, homeDir, filePath }) => {
      await mkdir(join(homeDir, '.config', 'opencode'), { recursive: true });
      const existingJsonc = [
        '// My opencode config',
        '{',
        '  // Model setting',
        '  "model": "claude-3-5-sonnet",',
        '  "mcp": {',
        '    "existingServer": { "type": "local", "command": ["x"], "enabled": true }',
        '  }',
        '}',
      ].join('\n');
      await writeFile(filePath, existingJsonc, 'utf8');

      await runInstallCore(['--target', 'opencode', '--yes'], ctx(cwd), homeDir);

      const text = await readFile(filePath, 'utf8');
      expect(text).toContain('// My opencode config');
      expect(text).toContain('// Model setting');
      const parsed = parseJsonc(text) as any;
      expect(parsed.model).toBe('claude-3-5-sonnet');
      expect(parsed.mcp.existingServer).toBeDefined();
      expect(parsed.mcp.astrograph.type).toBe('local');
      expect(parsed.mcp.astrograph.command).toEqual(['astrograph', 'serve', '--mcp']);
    }));

  test('install twice is idempotent', () =>
    withXdgTmp(async ({ cwd, homeDir }) => {
      await runInstallCore(['--target', 'opencode', '--yes'], ctx(cwd), homeDir);
      const r2 = await runInstallCore(['--target', 'opencode', '--yes'], ctx(cwd), homeDir);
      expect(r2.stdout).toContain('already configured');
    }));

  test('uninstall removes only astrograph and leaves the rest including comments', () =>
    withXdgTmp(async ({ cwd, homeDir, filePath }) => {
      await mkdir(join(homeDir, '.config', 'opencode'), { recursive: true });
      const withEntry = [
        '// keep this comment',
        '{',
        '  "mcp": {',
        '    "astrograph": { "type": "local", "command": ["astrograph", "serve", "--mcp"], "enabled": true },',
        '    "other": { "type": "local", "command": ["other"], "enabled": true }',
        '  }',
        '}',
      ].join('\n');
      await writeFile(filePath, withEntry, 'utf8');

      await runUninstallCore(['--target', 'opencode', '--yes'], ctx(cwd), homeDir);

      const text = await readFile(filePath, 'utf8');
      expect(text).toContain('// keep this comment');
      const parsed = parseJsonc(text) as any;
      expect(parsed.mcp.other).toBeDefined();
      expect(parsed.mcp.astrograph).toBeUndefined();
    }));

  test('uninstall when absent is a no-op', () =>
    withXdgTmp(async ({ cwd, homeDir }) => {
      const r = await runUninstallCore(['--target', 'opencode', '--yes'], ctx(cwd), homeDir);
      expect(r.exitCode).toBe(0);
    }));

  test('--print-config prints entry without creating file', () =>
    withXdgTmp(async ({ cwd, homeDir, filePath }) => {
      const result = await runInstallCore(['--print-config', 'opencode'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"astrograph"');
      expect(result.stdout).toContain('"local"');
      expect(existsSync(filePath)).toBe(false);
    }));
});

// ---------------------------------------------------------------------------
// Cross-cutting: --command override, multi-target, unknown target
// ---------------------------------------------------------------------------

describe('cross-cutting', () => {
  test('--command overrides the binary in all targets', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    try {
      await runInstallCore(['--target', 'claude', '--command', '/usr/local/bin/astrograph', '--yes'], ctx(cwd), homeDir);
      const parsed = JSON.parse(await readFile(join(homeDir, '.claude.json'), 'utf8'));
      expect(parsed.mcpServers.astrograph.command).toBe('/usr/local/bin/astrograph');
      expect(parsed.mcpServers.astrograph.args).toEqual(['serve', '--mcp']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('unknown target exits with error', async () => {
    const { root, cwd } = await makeTmpHome();
    try {
      const result = await runCli(['install', '--target', 'bogus', '--yes'], ctx(cwd));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown target');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('install all targets at once', async () => {
    const { root, cwd, homeDir } = await makeTmpHome();
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(homeDir, '.config');
    try {
      const result = await runInstallCore(['--yes'], ctx(cwd), homeDir);
      expect(result.exitCode).toBe(0);
      // Claude, Cursor, Codex, opencode
      expect(existsSync(join(homeDir, '.claude.json'))).toBe(true);
      expect(existsSync(join(homeDir, '.cursor', 'mcp.json'))).toBe(true);
      expect(existsSync(join(homeDir, '.codex', 'config.toml'))).toBe(true);
      expect(existsSync(join(homeDir, '.config', 'opencode', 'opencode.jsonc'))).toBe(true);
    } finally {
      if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
      else delete process.env.XDG_CONFIG_HOME;
      await rm(root, { recursive: true, force: true });
    }
  });
});
