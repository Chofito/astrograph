export type Location = 'global' | 'local';

export interface McpEntry {
  command: string;
  args: string[];
}

export interface AgentGuideLink {
  path: string;
  source: 'directory' | 'file';
}

export interface Target {
  id: string;
  label: string;
  configPath(location: Location, cwd: string, homeDir: string): string;
  agentGuide?(location: Location, cwd: string, homeDir: string): AgentGuideLink | undefined;
  supportsLocation(location: Location): boolean;
  read(filePath: string): Promise<unknown>;
  hasEntry(doc: unknown): boolean;
  upsert(doc: unknown, entry: McpEntry): unknown;
  remove(doc: unknown): unknown;
  serialize(doc: unknown): string;
}
