import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openProject } from '../adapters/bun/project';
import type { Astrograph } from '../astrograph';
import type { EdgeRef, NodeRef } from '../types';

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

describe('GraphQueries', () => {
  test('callers and callees return exact node refs and call-site lines', async () => {
    const graph = await indexFixtureProject();
    try {
      const helper = mustNode(graph, 'helper');
      const run = mustNode(graph, 'run');

      const callers = await graph.callers({ symbol: 'helper' });
      expect(callers.data.map((item) => ({ caller: item.caller, callSite: callSiteFields(item.callSite) }))).toEqual([{
        caller: toExpectedRef(run),
        callSite: {
          source: run.id,
          target: helper.id,
          kind: 'calls',
          resolutionState: 'resolved',
          confidence: 'high',
          line: 6,
          col: 11,
        },
      }]);

      const callees = await graph.callees({ symbol: 'run' });
      expect(callees.data.map((item) => ({ callee: item.callee, callSite: callSiteFields(item.callSite) }))).toEqual([{
        callee: toExpectedRef(helper),
        callSite: {
          source: run.id,
          target: helper.id,
          kind: 'calls',
          resolutionState: 'resolved',
          confidence: 'high',
          line: 6,
          col: 11,
        },
      }]);
    } finally {
      graph.close();
    }
  });

  test('callers and callees hide external nodes by default and include them on opt-in', async () => {
    const graph = await indexFixtureProject();
    try {
      const run = mustNode(graph, 'run');
      const helper = mustNode(graph, 'helper');
      const externalFn = graph.queries.getAllNodes().find((node) => node.name === 'externalFn' && node.isExternal);
      expect(externalFn).toBeDefined();

      const defaultCallees = await graph.callees({ symbol: 'run' });
      expect(defaultCallees.data.map((item) => item.callee.name)).toEqual(['helper']);

      const withExternalCallees = await graph.callees({ symbol: 'run', includeExternal: true });
      expect(withExternalCallees.data.map((item) => item.callee.name)).toEqual(['externalFn', 'helper']);

      graph.queries.upsertEdge({
        source: externalFn!.id,
        target: helper.id,
        targetName: helper.name,
        kind: 'calls',
        resolutionState: 'resolved',
        confidence: 'high',
        provenance: 'synthesized:test',
        line: 1,
        col: 0,
      });

      const defaultCallers = await graph.callers({ symbol: 'helper' });
      expect(defaultCallers.data.map((item) => item.caller.name)).toEqual([run.name]);

      const withExternalCallers = await graph.callers({ symbol: 'helper', includeExternal: true });
      expect(withExternalCallers.data.map((item) => item.caller.name)).toEqual(['externalFn', run.name]);
    } finally {
      graph.close();
    }
  });

  test('impact is bounded by depth and deterministic', async () => {
    const graph = await indexFixtureProject();
    try {
      const depthOne = await graph.impact({ symbol: 'leaf', depth: 1 });
      const depthTwo = await graph.impact({ symbol: 'leaf', depth: 2 });
      const repeat = await graph.impact({ symbol: 'leaf', depth: 2 });

      expect(depthOne.data.map((item) => [item.node.name, item.distance])).toEqual([['middle', 1]]);
      expect(depthTwo.data.map((item) => [item.node.name, item.distance])).toEqual([
        ['middle', 1],
        ['root', 2],
      ]);
      expect(repeat).toEqual(depthTwo);
    } finally {
      graph.close();
    }
  });

  test('trace returns a hop chain with bodies and fallback code when no path exists', async () => {
    const graph = await indexFixtureProject();
    try {
      const trace = await graph.trace({ from: 'root', to: 'leaf', maxDepth: 3 });
      expect(trace.data.found).toBe(true);
      expect(trace.data.hops.map((hop) => hop.node.name)).toEqual(['root', 'middle']);
      expect(trace.data.hops.map((hop) => hop.via.kind)).toEqual(['calls', 'calls']);
      expect(trace.data.hops[0]!.body.content).toBe([
        'export function root() {',
        '  return middle();',
        '}',
      ].join('\n'));
      expect(trace.data.destinationCallees).toEqual([]);

      const noPath = await graph.trace({ from: 'leaf', to: 'root', maxDepth: 2 });
      expect(noPath.data.found).toBe(false);
      expect(noPath.data.hops).toEqual([]);
      expect(noPath.data.endpoints?.map((endpoint) => endpoint.node.name)).toEqual(['leaf', 'root', 'middle']);
      expect(noPath.data.endpoints?.map((endpoint) => endpoint.body.filePath)).toEqual([
        'src/chain.ts',
        'src/chain.ts',
        'src/chain.ts',
      ]);
    } finally {
      graph.close();
    }
  });

  test('context returns ranked entry points, neighborhood code, reasons, and stats', async () => {
    const graph = await indexFixtureProject();
    try {
      const helper = mustNode(graph, 'helper');
      const run = mustNode(graph, 'run');

      const result = await graph.context({ task: 'helper', maxSymbols: 12 });
      const repeat = await graph.context({ task: 'helper', maxSymbols: 12 });

      expect(repeat).toEqual(result);
      expect(result.data.entryPoints.some((node) => node.id === helper.id)).toBe(true);
      expect(result.data.subgraph.nodes.some((node) => node.id === run.id)).toBe(true);
      expect(result.data.inclusionReasons[helper.id]).toBe('fts-match');
      expect(result.data.inclusionReasons[run.id]).toBe('calls:helper');
      expect(result.data.relatedFiles).toContain('src/a.ts');
      expect(result.data.relatedFiles).toContain('src/b.ts');
      expect(result.data.codeBlocks.length).toBeGreaterThan(0);
      expect(result.data.entryPoints.every((node) => !node.filePath.includes('node_modules'))).toBe(true);
      expect(result.data.subgraph.nodes.every((node) => !node.filePath.includes('node_modules'))).toBe(true);
      expect(result.data.stats).toEqual({
        nodeCount: result.data.subgraph.nodes.length,
        edgeCount: result.data.subgraph.edges.length,
        fileCount: result.data.relatedFiles.length,
        codeBlockCount: result.data.codeBlocks.length,
        totalCodeChars: result.data.codeBlocks.reduce((sum, block) => sum + block.content.length, 0),
      });
      expect(result.meta.partial).toBe(false);
    } finally {
      graph.close();
    }
  });

  test('context respects token budgets for code blocks', async () => {
    const graph = await indexFixtureProject();
    try {
      const result = await graph.context({ task: 'helper', maxSymbols: 6, tokenBudget: 5 });

      expect(result.data.stats.totalCodeChars).toBeLessThanOrEqual(20);
      expect(result.data.stats.codeBlockCount).toBe(result.data.codeBlocks.length);
    } finally {
      graph.close();
    }
  });

  test('context ranks generated and test symbols below real implementations with the same name', async () => {
    const graph = await indexFixtureProject();
    try {
      const result = await graph.context({ task: 'duplicateName', maxSymbols: 10, includeCode: false });

      const duplicateNodes = result.data.subgraph.nodes.filter((node) => node.name === 'duplicateName');
      const duplicatePaths = duplicateNodes.map((node) => node.filePath);
      expect(duplicatePaths).toContain('src/ranked.ts');
      expect(duplicatePaths).toContain('src/ranked.test.ts');
      expect(duplicatePaths).toContain('src/ranked.generated.ts');
      expect(duplicatePaths.indexOf('src/ranked.ts')).toBeLessThan(duplicatePaths.indexOf('src/ranked.test.ts'));
      expect(duplicatePaths.indexOf('src/ranked.ts')).toBeLessThan(duplicatePaths.indexOf('src/ranked.generated.ts'));
    } finally {
      graph.close();
    }
  });

  test('getNode includeCode returns the verbatim node slice', async () => {
    const graph = await indexFixtureProject();
    try {
      const result = await graph.getNode({ symbol: 'run', includeCode: true });
      expect(result.data.node.name).toBe('run');
      expect(result.data.code?.content).toBe([
        '  run() {',
        "    return helper('Ada') + externalFn();",
        '  }',
      ].join('\n'));
      expect(result.meta.partial).toBe(false);
    } finally {
      graph.close();
    }
  });

  test('explore groups code by file and maps relationships among included nodes', async () => {
    const graph = await indexFixtureProject();
    try {
      const result = await graph.explore({ query: 'run helper', maxFiles: 4 });

      expect(result.data.files.map((file) => file.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
      expect(result.data.files.some((file) => file.filePath.includes('node_modules'))).toBe(false);
      expect(result.data.files.map((file) => file.blocks.map((block) => block.filePath))).toEqual([
        ['src/a.ts'],
        ['src/b.ts'],
      ]);
      expect(result.data.relationshipMap.map((edge) => [edge.kind, edge.resolutionState])).toEqual([
        ['calls', 'resolved'],
      ]);
    } finally {
      graph.close();
    }
  });

  test('getFiles and getStats expose coverage and file metadata', async () => {
    const graph = await indexFixtureProject();
    try {
      const files = await graph.getFiles({ format: 'tree' });
      const indexedFiles = graph.queries.getAllFiles();
      expect(files.data).toEqual({
        format: 'tree',
        entries: indexedFiles.map((file) => ({
          filePath: file.path,
          language: file.language,
          nodeCount: file.nodeCount,
          coverageState: file.state,
        })),
      });
      expect(files.meta.partial).toBe(false);

      const status = await graph.getStats({});
      expect(status.data.coverage).toEqual({ total: indexedFiles.length, resolved: indexedFiles.length, parsed: 0, pending: 0 });
      expect(status.meta.coverage).toEqual(status.data.coverage);
      expect(status.meta.partial).toBe(false);
    } finally {
      graph.close();
    }
  });

  test('meta partial flips when scoped files are pending', async () => {
    const graph = await indexFixtureProject();
    try {
      const resolved = await graph.getNode({ symbol: 'helper' });
      expect(resolved.meta.partial).toBe(false);

      const file = graph.queries.getFile('src/b.ts');
      expect(file).not.toBeUndefined();
      graph.queries.upsertFile({ ...file!, state: 'pending' });

      const pending = await graph.getNode({ symbol: 'helper' });
      expect(pending.meta.coverage).toEqual({ total: 1, resolved: 0, parsed: 0, pending: 1 });
      expect(pending.meta.partial).toBe(true);
      expect(pending.meta.pendingFiles).toEqual(['src/b.ts']);
    } finally {
      graph.close();
    }
  });

  test('search is deterministic and wraps the coverage envelope', async () => {
    const graph = await indexFixtureProject();
    try {
      const first = await graph.search({ query: 'helper', kind: 'function' });
      const second = await graph.search({ query: 'helper', kind: 'function' });

      expect(second).toEqual(first);
      expect(first.data.map((item) => item.node.name)).toEqual(['helper']);
      expect(first.meta.coverage).toEqual({ total: graph.queries.getAllFiles().length, resolved: graph.queries.getAllFiles().length, parsed: 0, pending: 0 });
    } finally {
      graph.close();
    }
  });
});

async function indexFixtureProject(): Promise<Astrograph> {
  const root = await makeTempProject();
  await writeProjectFile(root, 'node_modules/fake-lib/index.d.ts', [
    'export declare function externalFn(): string;',
    '',
  ].join('\n'));
  await writeProjectFile(root, 'node_modules/fake-lib/package.json', [
    '{ "name": "fake-lib", "main": "index.js", "types": "index.d.ts" }',
    '',
  ].join('\n'));
  await writeProjectFile(root, 'tsconfig.json', [
    '{',
    '  "compilerOptions": {',
    '    "target": "ESNext",',
    '    "module": "ESNext",',
    '    "moduleResolution": "bundler",',
    '    "skipLibCheck": true,',
    '    "strict": true',
    '  },',
    '  "include": ["src/**/*.ts"]',
    '}',
    '',
  ].join('\n'));
  await writeProjectFile(root, 'src/b.ts', [
    'export class Base {',
    '  greet(name: string) {',
    '    return `hello ${name}`;',
    '  }',
    '}',
    '',
    'export function helper(name: string) {',
    '  return new Base().greet(name);',
    '}',
    '',
  ].join('\n'));
  await writeProjectFile(root, 'src/a.ts', [
    "import { helper, Base } from './b';",
    "import { externalFn } from 'fake-lib';",
    '',
    'export class Child extends Base {',
    '  run() {',
    "    return helper('Ada') + externalFn();",
    '  }',
    '}',
    '',
    'export function entry() {',
    '  const child = new Child();',
    '  return child.run();',
    '}',
    '',
  ].join('\n'));
  await writeProjectFile(root, 'src/chain.ts', [
    'export function leaf() {',
    '  return 1;',
    '}',
    '',
    'export function middle() {',
    '  return leaf();',
    '}',
    '',
    'export function root() {',
    '  return middle();',
    '}',
    '',
  ].join('\n'));
  await writeProjectFile(root, 'src/ranked.ts', [
    'export function duplicateName() {',
    "  return helper('real');",
    '}',
    '',
  ].join('\n'));
  await writeProjectFile(root, 'src/ranked.generated.ts', [
    'export function duplicateName() {',
    "  return 'generated';",
    '}',
    '',
  ].join('\n'));
  await writeProjectFile(root, 'src/ranked.test.ts', [
    'export function duplicateName() {',
    "  return 'test';",
    '}',
    '',
  ].join('\n'));

  const graph = await openProject(root, { dbPath: ':memory:', now: () => 100 });
  await graph.indexAll();
  return graph;
}

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/astrograph-queries-`);
  tempRoots.push(root);
  return root;
}

async function writeProjectFile(root: string, relPath: string, content: string): Promise<void> {
  const fullPath = `${root}/${relPath}`;
  const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, 'utf8');
}

function mustNode(graph: Astrograph, name: string): ReturnType<Astrograph['queries']['getAllNodes']>[number] {
  const node = graph.queries.getAllNodes().find((candidate) => candidate.name === name);
  if (node === undefined) throw new Error(`Missing node ${name}`);
  return node;
}

function toExpectedRef(node: ReturnType<typeof mustNode>): NodeRef {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    range: node.range,
    signature: node.signature,
  };
}

function callSiteFields(edge: EdgeRef): EdgeRef {
  return {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    resolutionState: edge.resolutionState,
    confidence: edge.confidence,
    line: edge.line,
    col: edge.col,
  };
}
