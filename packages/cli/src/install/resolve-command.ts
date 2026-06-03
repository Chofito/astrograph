export interface ResolvedCommand {
  command: string;
  args: string[];
}

export function resolveCommand(commandOverride?: string): ResolvedCommand {
  return {
    command: commandOverride ?? 'astrograph',
    args: ['serve', '--mcp'],
  };
}
