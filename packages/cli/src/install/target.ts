export type Location = 'global' | 'local';

export interface McpEntry {
  command: string;
  args: string[];
}

export interface Target {
  id: string;
  label: string;
  configPath(location: Location, cwd: string, homeDir: string): string;
  supportsLocation(location: Location): boolean;
  read(filePath: string): Promise<unknown>;
  hasEntry(doc: unknown): boolean;
  upsert(doc: unknown, entry: McpEntry): unknown;
  remove(doc: unknown): unknown;
  serialize(doc: unknown): string;
}
