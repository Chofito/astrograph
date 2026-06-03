import { join } from 'node:path';
import type { Location, McpEntry, Target } from '../target';
import { readJson, serializeJson, type JsonDoc } from '../writers/json';

export const cursorTarget: Target = {
  id: 'cursor',
  label: 'Cursor',

  configPath(location: Location, cwd: string, homeDir: string): string {
    return location === 'global'
      ? join(homeDir, '.cursor', 'mcp.json')
      : join(cwd, '.cursor', 'mcp.json');
  },

  supportsLocation(_location: Location): boolean {
    return true;
  },

  async read(filePath: string): Promise<JsonDoc> {
    return readJson(filePath);
  },

  hasEntry(doc: unknown): boolean {
    const d = doc as JsonDoc;
    return !!(d.mcpServers as Record<string, unknown> | undefined)?.astrograph;
  },

  upsert(doc: unknown, entry: McpEntry): JsonDoc {
    const d = doc as JsonDoc;
    return {
      ...d,
      mcpServers: {
        ...((d.mcpServers as Record<string, unknown>) ?? {}),
        astrograph: { type: 'stdio', command: entry.command, args: entry.args },
      },
    };
  },

  remove(doc: unknown): JsonDoc {
    const d = doc as JsonDoc;
    const servers = { ...((d.mcpServers as Record<string, unknown>) ?? {}) };
    delete servers.astrograph;
    return { ...d, mcpServers: servers };
  },

  serialize(doc: unknown): string {
    return serializeJson(doc as JsonDoc);
  },
};
