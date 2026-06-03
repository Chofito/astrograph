import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AstrographCore, EdgeRef, NodeRef, ToolMeta, WatchEvent, Watcher } from '@astrograph/core';
import { SERVER_INSTRUCTIONS } from '../instructions';
import { ProjectSession } from '../project';
import { callTool } from '../server';
import { createTools, type McpToolDefinition } from '../tools';

describe('MCP tools', () => {
  test('registers the 10 Astrograph facade tools', () => {
    const tools = createTools({ getGraph: async () => fakeGraph() });

    expect(tools.map((tool) => tool.name)).toEqual([
      'astrograph_search',
      'astrograph_context',
      'astrograph_trace',
      'astrograph_callers',
      'astrograph_callees',
      'astrograph_impact',
      'astrograph_node',
      'astrograph_explore',
      'astrograph_files',
      'astrograph_status',
    ]);
  });

  test('each tool returns agent text with an honest coverage banner', async () => {
    const tools = toolMap(createTools({ getGraph: async () => fakeGraph() }));
    const calls: [string, unknown, string][] = [
      ['astrograph_search', { query: 'makeNodeId' }, 'makeNodeId'],
      ['astrograph_context', { task: 'node ids' }, 'fts-match'],
      ['astrograph_trace', { from: 'Screen', to: 'useAccount' }, 'Trace: found'],
      ['astrograph_callers', { symbol: 'useAccount' }, 'Screen'],
      ['astrograph_callees', { symbol: 'Screen' }, 'useAccount'],
      ['astrograph_impact', { symbol: 'useAccount' }, 'Screen'],
      ['astrograph_node', { symbol: 'useAccount', includeCode: true }, 'export const useAccount'],
      ['astrograph_explore', { query: 'account' }, 'src/account.ts'],
      ['astrograph_files', {}, 'src/account.ts'],
      ['astrograph_status', {}, 'files 1'],
    ];

    for (const [name, args, expected] of calls) {
      const result = await callTool(tools, name, args);
      const text = textContent(result);
      expect(result.isError).toBeUndefined();
      expect(text).toContain(expected);
      expect(text).toContain('coverage 1/1 resolved · partial: no');
    }
  });

  test('missing index is returned as a tool error with init guidance', async () => {
    const root = await mkdtemp(`${tmpdir()}/astrograph-mcp-tool-no-index-`);
    try {
      const session = new ProjectSession({ cwd: root, open: async () => fakeGraph() as never });
      const result = await callTool(toolMap(createTools(session)), 'astrograph_status', {});

      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain('Run `astrograph init` first');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('first tool call runs reconcile before reading graph data', async () => {
    const root = await mkdtemp(`${tmpdir()}/astrograph-mcp-tool-sync-`);
    let synced = false;
    try {
      await mkdir(`${root}/.astrograph`, { recursive: true });
      const graph = {
        ...fakeGraph(),
        sync: async () => {
          synced = true;
          return { added: [], modified: ['src/fresh.ts'], removed: [] };
        },
        search: async () => ({
          data: [{ node: node(synced ? 'FreshSymbol' : 'StaleSymbol', 'src/fresh.ts', 1, 'function'), score: 1 }],
          meta: meta(),
        }),
      };
      const session = new ProjectSession({ cwd: root, open: async () => graph as never });
      const result = await callTool(toolMap(createTools(session)), 'astrograph_search', { query: 'fresh' });
      const text = textContent(result);

      expect(result.isError).toBeUndefined();
      expect(text).toContain('FreshSymbol');
      expect(text).not.toContain('StaleSymbol');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('watcher event is synced by the next tool call before reading results', async () => {
    const root = await mkdtemp(`${tmpdir()}/astrograph-mcp-tool-watch-`);
    let synced = false;
    let onEvent: ((event: WatchEvent) => void) | undefined;
    try {
      await mkdir(`${root}/.astrograph`, { recursive: true });
      const watcher: Watcher = {
        watch: (_paths, cb) => {
          onEvent = cb;
          return { close() {} };
        },
      };
      const graph = {
        ...fakeGraph(),
        syncFiles: async () => {
          synced = true;
          return { added: [], modified: ['src/live.ts'], removed: [] };
        },
        search: async () => ({
          data: [{ node: node(synced ? 'LiveSymbol' : 'OldSymbol', 'src/live.ts', 1, 'function'), score: 1 }],
          meta: meta(),
        }),
      };
      const session = new ProjectSession({
        cwd: root,
        watch: true,
        watcher,
        open: async () => graph as never,
      });
      await session.getGraph();
      onEvent?.({ type: 'change', path: `${root}/src/live.ts` });

      const result = await callTool(toolMap(createTools(session)), 'astrograph_search', { query: 'live' });
      const text = textContent(result);

      expect(result.isError).toBeUndefined();
      expect(text).toContain('LiveSymbol');
      expect(text).not.toContain('OldSymbol');
      expect(text).toContain('coverage 1/1 resolved · partial: no');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('server instructions steer agents toward Astrograph and coverage banners', () => {
    expect(SERVER_INSTRUCTIONS).toContain('Astrograph is a pre-built local code graph');
    expect(SERVER_INSTRUCTIONS).toContain('Always check the final coverage banner');
    expect(SERVER_INSTRUCTIONS).toContain('astrograph init');
  });
});

function textContent(result: Awaited<ReturnType<typeof callTool>>): string {
  const content = result.content[0];
  if (content?.type !== 'text') throw new Error('Expected MCP text content.');
  return content.text;
}

function toolMap(tools: McpToolDefinition[]): Map<string, McpToolDefinition> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function fakeGraph(): AstrographCore {
  const useAccount = node('useAccount', 'src/account.ts', 1, 'function');
  const screen = node('Screen', 'src/screen.ts', 5, 'component');
  const call = edge(screen.id, useAccount.id, 'useAccount');
  return {
    search: async () => ({ data: [{ node: node('makeNodeId', 'src/ids.ts', 10, 'function'), score: 2 }], meta: meta() }),
    context: async () => ({
      data: {
        entryPoints: [useAccount],
        subgraph: { nodes: [useAccount, screen], edges: [call] },
        codeBlocks: [block('src/account.ts', 'export const useAccount = () => account;')],
        inclusionReasons: { [useAccount.id]: 'fts-match', [screen.id]: 'called-by:useAccount' },
        relatedFiles: ['src/account.ts', 'src/screen.ts'],
        stats: { nodeCount: 2, edgeCount: 1, fileCount: 2, codeBlockCount: 1, totalCodeChars: 39 },
      },
      meta: meta(),
    }),
    trace: async () => ({ data: { found: true, hops: [{ node: screen, via: call, body: block('src/screen.ts', 'export const Screen = () => useAccount();') }] }, meta: meta() }),
    callers: async () => ({ data: [{ caller: screen, callSite: call }], meta: meta() }),
    callees: async () => ({ data: [{ callee: useAccount, callSite: call }], meta: meta() }),
    impact: async () => ({ data: [{ node: screen, distance: 1, viaPath: [call] }], meta: meta() }),
    getNode: async () => ({
      data: {
        node: useAccount,
        callersPreview: [screen],
        calleesPreview: [],
        code: block('src/account.ts', 'export const useAccount = () => account;'),
      },
      meta: meta(),
    }),
    explore: async () => ({ data: { files: [{ filePath: 'src/account.ts', blocks: [block('src/account.ts', 'export const useAccount = () => account;')] }], relationshipMap: [call] }, meta: meta() }),
    getFiles: async () => ({ data: { format: 'flat', entries: [{ filePath: 'src/account.ts', language: 'typescript', nodeCount: 1, coverageState: 'resolved' }] }, meta: meta() }),
    getStats: async () => ({ data: { nodeCount: 2, edgeCount: 1, fileCount: 1, nodesByKind: { function: 1, component: 1 }, edgesByKind: { calls: 1 }, filesByLanguage: { typescript: 1 }, coverage: meta().coverage, dbSizeBytes: 4096, lastUpdated: 0, backend: 'sqlite', journalMode: 'wal' }, meta: meta() }),
    indexAll: async () => {},
    sync: async () => ({ added: [], modified: [], removed: [] }),
    syncFiles: async () => ({ added: [], modified: [], removed: [] }),
    close: () => {},
  };
}

function node(name: string, filePath: string, line: number, kind: NodeRef['kind']): NodeRef {
  return {
    id: `node:${name}`,
    name,
    kind,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    range: { startLine: line, endLine: line + 2, startColumn: 0, endColumn: 1 },
  };
}

function edge(source: string, target: string, targetName: string): EdgeRef {
  return {
    source,
    target,
    targetName,
    kind: 'calls',
    resolutionState: 'resolved',
    confidence: 'high',
    line: 8,
    col: 10,
  };
}

function block(filePath: string, content: string) {
  return { filePath, startLine: 1, endLine: 1, language: 'typescript' as const, content };
}

function meta(): ToolMeta {
  return { coverage: { total: 1, resolved: 1, parsed: 0, pending: 0 }, partial: false };
}
