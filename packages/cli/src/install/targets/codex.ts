import { join } from 'node:path';
import type { Location, McpEntry, Target } from '../target';
import { readToml, serializeToml, type TomlDoc } from '../writers/toml';

export const codexTarget: Target = {
  id: 'codex',
  label: 'Codex',

  configPath(_location: Location, _cwd: string, homeDir: string): string {
    return join(homeDir, '.codex', 'config.toml');
  },

  supportsLocation(location: Location): boolean {
    return location === 'global';
  },

  async read(filePath: string): Promise<TomlDoc> {
    return readToml(filePath);
  },

  hasEntry(doc: unknown): boolean {
    const d = doc as TomlDoc;
    return !!(d.mcp_servers as Record<string, unknown> | undefined)?.astrograph;
  },

  upsert(doc: unknown, entry: McpEntry): TomlDoc {
    const d = doc as TomlDoc;
    return {
      ...d,
      mcp_servers: {
        ...((d.mcp_servers as Record<string, unknown>) ?? {}),
        astrograph: { command: entry.command, args: entry.args },
      },
    };
  },

  remove(doc: unknown): TomlDoc {
    const d = doc as TomlDoc;
    const servers = { ...((d.mcp_servers as Record<string, unknown>) ?? {}) };
    delete servers.astrograph;
    return { ...d, mcp_servers: servers };
  },

  serialize(doc: unknown): string {
    return serializeToml(doc as TomlDoc);
  },
};
