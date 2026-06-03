import pkg from '../package.json';

export function versionText(): string {
  return `astrograph ${pkg.version}`;
}

export function globalHelp(): string {
  return [
    'Usage: astrograph <command> [options]',
    '',
    'Lifecycle:',
    '  init [path]              Create .astrograph and index by default',
    '    --no-index             Create .astrograph without indexing',
    '    -d, --detached         Start background daemon with watcher',
    '  uninit [path]            Remove .astrograph',
    '  index [path]             Reindex project',
    '  sync [path]              Index changed files',
    '  status [path]            Show index status',
    '  unlock [path]            Remove stale lock file',
    '  stop [path]              Stop background daemon',
    '',
    'Queries:',
    '  search <query>           Find symbols (aliases: query, q)',
    '  context <task>           Build task context',
    '  trace <from> <to>        Trace a call/reference path',
    '  callers <symbol>         Show callers',
    '  callees <symbol>         Show callees',
    '  impact <symbol>          Show reverse impact',
    '  node <symbol>            Show one symbol',
    '  explore <terms...>       Group related code by file',
    '  files                    Show indexed files',
    '  serve --mcp [--no-watch] Start the stdio MCP server',
    '',
    'MCP install:',
    '  install                  Install MCP server config in host(s)',
    '  uninstall                Remove MCP server config from host(s)',
    '',
    'Global:',
    '  -h, --help               Show help',
    '  --version                Show version',
  ].join('\n');
}

export function commandHelp(command: string): string {
  const usage: Record<string, string> = {
    init: [
      'Usage: astrograph init [path] [options]',
      '',
      'Options:',
      '  --no-index               Create .astrograph without indexing',
      '  -d, --detached           Start background daemon with watcher',
      '  -v, --verbose            Show full path in output',
    ].join('\n'),
    uninit: 'Usage: astrograph uninit [path] [-f]',
    index: 'Usage: astrograph index [path] [-f] [-q] [-v]',
    sync: 'Usage: astrograph sync [path] [-q]',
    status: 'Usage: astrograph status [path] [-j]',
    unlock: 'Usage: astrograph unlock [path]',
    stop: 'Usage: astrograph stop [path]',
    daemon: 'Usage: astrograph daemon --path <dir> (internal)',
    search: 'Usage: astrograph search <query> [-l 10] [-k kind] [--lang lang] [--no-generated] [-j]',
    query: 'Usage: astrograph query <query> [-l 10] [-k kind] [--lang lang] [--no-generated] [-j]',
    q: 'Usage: astrograph q <query> [-l 10] [-k kind] [--lang lang] [--no-generated] [-j]',
    context: 'Usage: astrograph context <task> [-n 20] [--no-code] [--budget tokens] [-f markdown|json]',
    trace: 'Usage: astrograph trace <from> <to> [-d maxDepth] [-j]',
    callers: 'Usage: astrograph callers <symbol> [-l 20] [--include-external] [-j]',
    callees: 'Usage: astrograph callees <symbol> [-l 20] [--include-external] [-j]',
    impact: 'Usage: astrograph impact <symbol> [-d 2] [--include-external] [-j]',
    node: 'Usage: astrograph node <symbol> [-c] [-j]',
    explore: 'Usage: astrograph explore <terms...> [--max-files 12] [-j]',
    files: 'Usage: astrograph files [--filter dir] [--pattern glob] [--format tree|flat|grouped] [-j]',
    serve: 'Usage: astrograph serve --mcp [--path dir] [--no-watch]',
    install: [
      'Usage: astrograph install [options]',
      '',
      'Options:',
      '  -t, --target <ids>       Comma-separated targets: claude,cursor,codex,opencode (default: all)',
      '  -l, --location <scope>   global or local (default: global)',
      '      --command <bin>      Override the astrograph binary path (default: astrograph)',
      '  -y, --yes                Skip confirmation prompt',
      '      --print-config <id>  Dry-run: print what would be written for this target',
      '',
      'Targets:',
      '  claude    ~/.claude.json (global) or ./.mcp.json (local)',
      '  cursor    ~/.cursor/mcp.json (global) or ./.cursor/mcp.json (local)',
      '  codex     ~/.codex/config.toml (global only)',
      '  opencode  ~/.config/opencode/opencode.jsonc (global) or ./opencode.jsonc (local)',
    ].join('\n'),
    uninstall: [
      'Usage: astrograph uninstall [options]',
      '',
      'Options:',
      '  -t, --target <ids>   Comma-separated targets: claude,cursor,codex,opencode (default: all)',
      '  -l, --location <scope>  global or local (default: global)',
      '  -y, --yes            Skip confirmation prompt',
    ].join('\n'),
  };
  return usage[command] ?? globalHelp();
}
