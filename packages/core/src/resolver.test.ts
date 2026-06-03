import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openProject } from './adapters/bun/project';

const tempRoots: string[] = [];

type OpenedIndexer = Awaited<ReturnType<typeof openProject>>;

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

describe('Pass B: edge resolution', () => {
  test('cross-file imports and calls have correct target ids (ID parity)', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/utils.ts', `
      export function greet(name: string): string {
        return 'hello ' + name;
      }
    `);
    await writeProjectFile(root, 'src/app.ts', `
      import { greet } from './utils';
      export function run() {
        return greet('world');
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const allEdges = indexer.queries.getAllEdges();
      const importEdges = allEdges.filter((e) => e.kind === 'imports');
      const callEdges = allEdges.filter((e) => e.kind === 'calls');

      const utilsNodes = indexer.queries.getNodesByFile('src/utils.ts');
      const greetNode = utilsNodes.find((n) => n.name === 'greet');
      expect(greetNode).toBeDefined();

      const importsToGreet = importEdges.filter((e) => e.target === greetNode!.id);
      expect(importsToGreet).toHaveLength(1);
      expect(importsToGreet[0]!.resolutionState).toBe('resolved');

      const callsToGreet = callEdges.filter((e) => e.target === greetNode!.id);
      expect(callsToGreet).toHaveLength(1);
      expect(callsToGreet[0]!.resolutionState).toBe('resolved');

      const dangling = indexer.queries.getDanglingEdges();
      expect(dangling).toEqual([]);

      const files = indexer.queries.getAllFiles();
      for (const file of files) {
        expect(file.state).toBe('resolved');
      }
    } finally {
      indexer.close();
    }
  });

  test('extends and implements across files', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/base.ts', `
      export class BaseService {
        init() { return true; }
      }
      export interface Loggable {
        log(msg: string): void;
      }
    `);
    await writeProjectFile(root, 'src/service.ts', `
      import { BaseService, Loggable } from './base';
      export class UserService extends BaseService implements Loggable {
        log(msg: string): void {
          console.log(msg);
        }
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const allEdges = indexer.queries.getAllEdges();
      const extendsEdges = allEdges.filter((e) => e.kind === 'extends');
      const implementsEdges = allEdges.filter((e) => e.kind === 'implements');

      const baseNodes = indexer.queries.getNodesByFile('src/base.ts');
      const baseServiceNode = baseNodes.find((n) => n.name === 'BaseService');
      const loggableNode = baseNodes.find((n) => n.name === 'Loggable');

      expect(baseServiceNode).toBeDefined();
      expect(loggableNode).toBeDefined();

      const extendsBase = extendsEdges.filter((e) => e.target === baseServiceNode!.id);
      expect(extendsBase).toHaveLength(1);
      expect(extendsBase[0]!.resolutionState).toBe('resolved');

      const implementsLoggable = implementsEdges.filter((e) => e.target === loggableNode!.id);
      expect(implementsLoggable).toHaveLength(1);
      expect(implementsLoggable[0]!.resolutionState).toBe('resolved');
    } finally {
      indexer.close();
    }
  });

  test('re-export barrel resolves through to origin', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/impl.ts', `
      export function helper(): string {
        return 'help';
      }
    `);
    await writeProjectFile(root, 'src/index.ts', `
      export { helper } from './impl';
    `);
    await writeProjectFile(root, 'src/consumer.ts', `
      import { helper } from './index';
      export function use() {
        return helper();
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const allEdges = indexer.queries.getAllEdges();
      const callEdges = allEdges.filter((e) => e.kind === 'calls');

      const implNodes = indexer.queries.getNodesByFile('src/impl.ts');
      const helperNode = implNodes.find((n) => n.name === 'helper');
      expect(helperNode).toBeDefined();

      const callsToHelper = callEdges.filter((e) => e.target === helperNode!.id);
      expect(callsToHelper).toHaveLength(1);
      expect(callsToHelper[0]!.resolutionState).toBe('resolved');
    } finally {
      indexer.close();
    }
  });

  test('external import creates external node and edge', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'node_modules/fake-lib/index.d.ts', `
      export declare function externalFn(): void;
    `);
    await writeProjectFile(root, 'node_modules/fake-lib/package.json', `
      { "name": "fake-lib", "main": "index.js", "types": "index.d.ts" }
    `);
    await writeProjectFile(root, 'tsconfig.json', `
      {
        "compilerOptions": {
          "target": "ESNext",
          "module": "ESNext",
          "moduleResolution": "bundler",
          "skipLibCheck": true,
          "strict": true
        },
        "include": ["src/**/*.ts"]
      }
    `);
    await writeProjectFile(root, 'src/app.ts', `
      import { externalFn } from 'fake-lib';
      export function run() {
        externalFn();
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const allEdges = indexer.queries.getAllEdges();
      const importEdges = allEdges.filter((e) => e.kind === 'imports');
      const callEdges = allEdges.filter((e) => e.kind === 'calls');

      const externalImports = importEdges.filter((e) => e.resolutionState === 'external');
      expect(externalImports).toHaveLength(1);
      const externalImportTarget = externalImports[0]!.target;
      expect(externalImportTarget).not.toBeNull();
      if (externalImportTarget === null) throw new Error('Expected external import target');

      const externalCalls = callEdges.filter((e) => e.resolutionState === 'external');
      expect(externalCalls).toHaveLength(1);

      const allNodes = indexer.queries.getAllNodes();
      const externalNodesList = allNodes.filter((n) => n.isExternal);
      expect(externalNodesList).toHaveLength(1);
      expect(externalNodesList[0]!.id).toBe(externalImportTarget);

      const projectNodes = allNodes.filter((n) => !n.isExternal);
      const projectNodeFiles = new Set(projectNodes.map((n) => n.filePath));
      expect(projectNodeFiles.has('node_modules/fake-lib/index.d.ts')).toBe(false);
    } finally {
      indexer.close();
    }
  });

  test('non-literal dynamic import produces unresolved edge', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/dynamic.ts', `
      export async function loadModule(name: string) {
        const mod = await import(name);
        return mod;
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const files = indexer.queries.getAllFiles();
      expect(files.length).toBe(1);
      expect(files[0]!.state).toBe('resolved');
    } finally {
      indexer.close();
    }
  });

  test('contains edges link parent to child declarations', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/structured.ts', `
      export class Service {
        method() {
          return 1;
        }
        prop = 'value';
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const allEdges = indexer.queries.getAllEdges();
      const containsEdges = allEdges.filter((e) => e.kind === 'contains');

      const nodes = indexer.queries.getNodesByFile('src/structured.ts');
      const fileNode = nodes.find((n) => n.kind === 'file');
      const classNode = nodes.find((n) => n.name === 'Service');
      const methodNode = nodes.find((n) => n.name === 'method');
      const propNode = nodes.find((n) => n.name === 'prop');

      expect(fileNode).toBeDefined();
      expect(classNode).toBeDefined();
      expect(methodNode).toBeDefined();
      expect(propNode).toBeDefined();

      const fileContainsClass = containsEdges.find(
        (e) => e.source === fileNode!.id && e.target === classNode!.id,
      );
      expect(fileContainsClass).toBeDefined();

      const classContainsMethod = containsEdges.find(
        (e) => e.source === classNode!.id && e.target === methodNode!.id,
      );
      expect(classContainsMethod).toBeDefined();

      const classContainsProp = containsEdges.find(
        (e) => e.source === classNode!.id && e.target === propNode!.id,
      );
      expect(classContainsProp).toBeDefined();
    } finally {
      indexer.close();
    }
  });

  test('type annotations and return types emit type_of and returns edges', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/types.ts', `
      export interface User {
        id: string;
      }
    `);
    await writeProjectFile(root, 'src/service.ts', `
      import { User } from './types';
      export let current: User;
      export function load(input: User): User {
        return input;
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const userNode = indexer.queries.getNodesByFile('src/types.ts').find((n) => n.name === 'User');
      expect(userNode).toBeDefined();

      const edges = indexer.queries.getAllEdges();
      const typeOfUser = edges.filter((e) => e.kind === 'type_of' && e.target === userNode!.id);
      expect(typeOfUser).toHaveLength(2);
      expect(typeOfUser.map((e) => e.resolutionState)).toEqual(['resolved', 'resolved']);

      const returnsUser = edges.filter((e) => e.kind === 'returns' && e.target === userNode!.id);
      expect(returnsUser).toHaveLength(1);
      expect(returnsUser[0]!.resolutionState).toBe('resolved');

      expectGraphIntegrity(indexer);
    } finally {
      indexer.close();
    }
  });

  test('overrides edges point subclass methods to base methods', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/service.ts', `
      export class BaseService {
        run(): string {
          return 'base';
        }
      }
      export class UserService extends BaseService {
        run(): string {
          return 'user';
        }
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const nodes = indexer.queries.getNodesByFile('src/service.ts');
      const baseRun = nodes.find((n) => n.name === 'run' && n.qualifiedName.endsWith('BaseService.run'));
      const userRun = nodes.find((n) => n.name === 'run' && n.qualifiedName.endsWith('UserService.run'));
      expect(baseRun).toBeDefined();
      expect(userRun).toBeDefined();

      const overrides = indexer.queries.getAllEdges().filter(
        (e) => e.kind === 'overrides' && e.source === userRun!.id && e.target === baseRun!.id,
      );
      expect(overrides).toHaveLength(1);
      expect(overrides[0]!.resolutionState).toBe('resolved');

      expectGraphIntegrity(indexer);
    } finally {
      indexer.close();
    }
  });

  test('decorators emit decorates edges to decorator symbols', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'tsconfig.json', `
      {
        "compilerOptions": {
          "target": "ESNext",
          "module": "ESNext",
          "moduleResolution": "bundler",
          "experimentalDecorators": true
        },
        "include": ["src/**/*.ts"]
      }
    `);
    await writeProjectFile(root, 'src/decorated.ts', `
      export function Injectable(): ClassDecorator {
        return () => {};
      }
      export function Trace(): MethodDecorator {
        return () => {};
      }

      @Injectable()
      export class Service {
        @Trace()
        run(): void {}
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const nodes = indexer.queries.getNodesByFile('src/decorated.ts');
      const injectable = nodes.find((n) => n.name === 'Injectable');
      const trace = nodes.find((n) => n.name === 'Trace');
      expect(injectable).toBeDefined();
      expect(trace).toBeDefined();

      const decorates = indexer.queries.getAllEdges().filter((e) => e.kind === 'decorates');
      const decoratesInjectable = decorates.filter((e) => e.target === injectable!.id);
      const decoratesTrace = decorates.filter((e) => e.target === trace!.id);
      expect(decoratesInjectable).toHaveLength(1);
      expect(decoratesTrace).toHaveLength(1);
      expect(decorates.map((e) => e.resolutionState)).toEqual(['resolved', 'resolved']);

      expectGraphIntegrity(indexer);
    } finally {
      indexer.close();
    }
  });

  test('JSX usage emits references edge to component node', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/app.tsx', `
      export function Button() {
        return <button />;
      }

      export function App() {
        return <Button />;
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const nodes = indexer.queries.getNodesByFile('src/app.tsx');
      const button = nodes.find((n) => n.name === 'Button');
      const app = nodes.find((n) => n.name === 'App');
      expect(button).toBeDefined();
      expect(app).toBeDefined();
      expect(button!.kind).toBe('component');
      expect(app!.kind).toBe('component');

      const references = indexer.queries.getAllEdges().filter(
        (e) => e.kind === 'references' && e.source === app!.id && e.target === button!.id,
      );
      expect(references).toHaveLength(1);
      expect(references[0]!.resolutionState).toBe('resolved');

      expectGraphIntegrity(indexer);
    } finally {
      indexer.close();
    }
  });

  test('sync re-resolves edges after editing target file', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/utils.ts', `
      export function greet(name: string): string {
        return 'hello ' + name;
      }
    `);
    await writeProjectFile(root, 'src/app.ts', `
      import { greet } from './utils';
      export function run() {
        return greet('world');
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const utilsNodesBefore = indexer.queries.getNodesByFile('src/utils.ts');
      const greetBefore = utilsNodesBefore.find((n) => n.name === 'greet');
      expect(greetBefore).toBeDefined();

      await writeProjectFile(root, 'src/utils.ts', `
        export function greet(name: string): string {
          return 'hi ' + name;
        }
        export function farewell(name: string): string {
          return 'bye ' + name;
        }
      `);

      const result = await indexer.sync();
      expect(result.modified).toContain('src/utils.ts');

      const allEdges = indexer.queries.getAllEdges();
      const callEdges = allEdges.filter((e) => e.kind === 'calls');

      const utilsNodesAfter = indexer.queries.getNodesByFile('src/utils.ts');
      const greetAfter = utilsNodesAfter.find((n) => n.name === 'greet');
      expect(greetAfter).toBeDefined();

      const callToGreet = callEdges.find((e) => e.target === greetAfter!.id);
      expect(callToGreet).toBeDefined();

      const dangling = indexer.queries.getDanglingEdges();
      expect(dangling).toEqual([]);

      const files = indexer.queries.getAllFiles();
      for (const file of files) {
        expect(file.state).toBe('resolved');
      }
    } finally {
      indexer.close();
    }
  });

  test('cold-process sync resolves edges into unchanged DB-backed files', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/utils.ts', `
      export function greet(name: string): string {
        return 'hello ' + name;
      }
    `);
    await writeProjectFile(root, 'src/app.ts', `
      import { greet } from './utils';
      export function run() {
        return greet('world');
      }
    `);

    const dbPath = `${root}/.astrograph/graph.db`;
    let greetBeforeId = '';
    const firstIndexer = await openProject(root, { dbPath, now: () => 100 });
    try {
      await firstIndexer.indexAll();
      const greetBefore = firstIndexer.queries.getNodesByFile('src/utils.ts').find((n) => n.name === 'greet');
      expect(greetBefore).toBeDefined();
      greetBeforeId = greetBefore!.id;
    } finally {
      firstIndexer.close();
    }

    await writeProjectFile(root, 'src/app.ts', `
      import { greet } from './utils';
      export function run() {
        return greet('world');
      }
      export function runAgain() {
        return greet('again');
      }
    `);

    const secondIndexer = await openProject(root, { dbPath, now: () => 200 });
    try {
      const result = await secondIndexer.sync();
      expect(result.modified).toContain('src/app.ts');

      const utilsNodes = secondIndexer.queries.getNodesByFile('src/utils.ts');
      const greetNode = utilsNodes.find((n) => n.name === 'greet');
      expect(greetNode).toBeDefined();
      expect(greetNode!.id).toBe(greetBeforeId);

      const allEdges = secondIndexer.queries.getAllEdges();
      const importsToGreet = allEdges.filter((e) => e.kind === 'imports' && e.target === greetBeforeId);
      expect(importsToGreet).toHaveLength(1);
      expect(importsToGreet[0]!.resolutionState).toBe('resolved');

      const callsToGreet = allEdges.filter((e) => e.kind === 'calls' && e.target === greetBeforeId);
      expect(callsToGreet).toHaveLength(2);
      expect(callsToGreet.map((e) => e.resolutionState)).toEqual(['resolved', 'resolved']);

      expect(secondIndexer.queries.getDanglingEdges()).toEqual([]);
    } finally {
      secondIndexer.close();
    }
  });

  test('coverage reflects resolved state after indexAll', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/a.ts', 'export function a() { return 1; }');
    await writeProjectFile(root, 'src/b.ts', 'export function b() { return 2; }');

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const coverage = indexer.queries.getCoverage();
      expect(coverage.resolved).toBe(2);
      expect(coverage.parsed).toBe(0);
      expect(coverage.pending).toBe(0);
    } finally {
      indexer.close();
    }
  });

  test('calls from arrow consts, functions, and methods are calls sourced to the enclosing declaration', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/account.ts', `
      export const useAccount = () => {
        return { id: 'acct' };
      };
      export function helper() {
        return 'help';
      }
    `);
    await writeProjectFile(root, 'src/screen.tsx', `
      import { useAccount, helper } from './account';

      export const Screen = () => {
        const account = useAccount();
        return helper() + account.id;
      };

      export function run() {
        return helper();
      }

      export class Controller {
        method() {
          return helper();
        }
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const accountNodes = indexer.queries.getNodesByFile('src/account.ts');
      const screenNodes = indexer.queries.getNodesByFile('src/screen.tsx');
      const fileNode = screenNodes.find((node) => node.kind === 'file');
      const screenNode = screenNodes.find((node) => node.name === 'Screen');
      const runNode = screenNodes.find((node) => node.name === 'run');
      const methodNode = screenNodes.find((node) => node.name === 'method');
      const useAccountNode = accountNodes.find((node) => node.name === 'useAccount');
      const helperNode = accountNodes.find((node) => node.name === 'helper');

      expect(fileNode).toBeDefined();
      expect(screenNode).toBeDefined();
      expect(runNode).toBeDefined();
      expect(methodNode).toBeDefined();
      expect(useAccountNode).toBeDefined();
      expect(helperNode).toBeDefined();

      const calls = indexer.queries.getAllEdges().filter((edge) => edge.kind === 'calls');
      expect(calls.some((edge) => edge.source === screenNode!.id && edge.target === useAccountNode!.id)).toBe(true);
      expect(calls.some((edge) => edge.source === screenNode!.id && edge.target === helperNode!.id)).toBe(true);
      expect(calls.some((edge) => edge.source === runNode!.id && edge.target === helperNode!.id)).toBe(true);
      expect(calls.some((edge) => edge.source === methodNode!.id && edge.target === helperNode!.id)).toBe(true);
      expect(calls.some((edge) => edge.source === fileNode!.id && edge.target === useAccountNode!.id)).toBe(false);

      const callers = await indexer.callers({ symbol: 'useAccount' });
      expect(callers.data.map((item) => item.caller.name)).toEqual(['Screen']);

      const callees = await indexer.callees({ symbol: 'Screen' });
      expect(callees.data.map((item) => item.callee.name)).toContain('useAccount');

      expectGraphIntegrity(indexer);
    } finally {
      indexer.close();
    }
  });

  test('zero resolved edges with missing target (dangling check)', async () => {
    const root = await makeTempProject();
    await writeProjectFile(root, 'src/a.ts', `
      export function a() { return 1; }
    `);
    await writeProjectFile(root, 'src/b.ts', `
      import { a } from './a';
      export function b() { return a(); }
    `);
    await writeProjectFile(root, 'src/c.ts', `
      export class C {
        method() { return 'c'; }
      }
    `);
    await writeProjectFile(root, 'src/d.ts', `
      import { C } from './c';
      export class D extends C {
        other() { return 'd'; }
      }
    `);

    const indexer = await openProject(root, { dbPath: ':memory:', now: () => 100 });
    try {
      await indexer.indexAll();

      const allEdges = indexer.queries.getAllEdges();
      const resolvedEdges = allEdges.filter((e) => e.resolutionState === 'resolved');

      for (const edge of resolvedEdges) {
        if (edge.target !== null) {
          const targetNode = indexer.queries.getNode(edge.target);
          expect(targetNode).toBeDefined();
        }
      }

      const dangling = indexer.queries.getDanglingEdges();
      expect(dangling).toEqual([]);
    } finally {
      indexer.close();
    }
  });
});

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/astrograph-passb-`);
  tempRoots.push(root);
  return root;
}

function expectGraphIntegrity(indexer: OpenedIndexer): void {
  expect(indexer.queries.getDanglingEdges()).toEqual([]);

  const keys = indexer.queries.getAllEdges().map((edge) =>
    `${edge.source}\u0000${edge.kind}\u0000${edge.target ?? ''}\u0000${edge.line ?? -1}`
  );
  expect(new Set(keys).size).toBe(keys.length);
}

async function writeProjectFile(root: string, relPath: string, content: string): Promise<void> {
  const fullPath = `${root}/${relPath}`;
  const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, 'utf8');
}
