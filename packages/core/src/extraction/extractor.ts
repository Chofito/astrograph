import ts from 'typescript';
import type {
  Extractor,
  Node,
  Edge,
  ExtractionError,
  Hasher,
  NodeKind,
  Language,
  LoadProjectOptions,
} from '../types';
import { makeNodeId } from '../ids';
import { languageFromPath } from './language';
import { isGenerated, isTest } from './classify';
import {
  computeNodeIdentity,
  getRange,
  extractDocstring,
  extractDecorators,
  extractTypeParameters,
  hasExportModifier,
  hasDefaultModifier,
  hasAsyncModifier,
  hasStaticModifier,
  hasAbstractModifier,
  getVisibility,
} from './identity';
import { resolveEdgesForFile } from './resolver';

export interface TsExtractorOptions {
  hasher: Hasher;
  now?: () => number;
  project?: string;
}

export class TsExtractor implements Extractor {
  private readonly hasher: Hasher;
  private readonly now: () => number;
  private readonly project: string;

  private program: ts.Program | undefined;
  private checker: ts.TypeChecker | undefined;
  private rootPath: string | undefined;
  private projectFiles: Set<string> = new Set();
  private absolutePathMap: Map<string, string> = new Map();
  private nodesByFile: Map<string, Node[]> = new Map();
  private loadNodesForFile: (filePath: string) => Node[] = () => [];

  constructor(opts: TsExtractorOptions) {
    this.hasher = opts.hasher;
    this.now = opts.now ?? Date.now;
    this.project = opts.project ?? 'root';
  }

  loadProject(opts: LoadProjectOptions): void {
    this.rootPath = opts.rootPath.replaceAll('\\', '/').replace(/\/$/, '');
    this.nodesByFile = new Map();
    this.loadNodesForFile = opts.loadNodesForFile ?? (() => []);

    const configPath = opts.tsconfigPath
      ? `${this.rootPath}/${opts.tsconfigPath}`.replaceAll('//', '/')
      : findConfigFile(this.rootPath);

    let configFileNames: string[] = [];
    let compilerOptions: ts.CompilerOptions = {
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      skipLibCheck: true,
    };

    if (configPath) {
      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
      if (configFile.config) {
        const parsed = ts.parseJsonConfigFileContent(
          configFile.config,
          ts.sys,
          configPath.slice(0, configPath.lastIndexOf('/')),
        );
        configFileNames = parsed.fileNames;
        compilerOptions = { ...parsed.options, skipLibCheck: true };
      }
    }

    const indexedFiles = normalizeIndexedFiles(opts.fileNames, this.rootPath);
    const indexedFileNames = indexedFiles.map((f) => this.toAbsolute(f));
    const fileNames = uniqueStrings([...configFileNames, ...indexedFileNames]);

    this.program = ts.createProgram({
      rootNames: fileNames,
      options: compilerOptions,
    });
    this.checker = this.program.getTypeChecker();

    const projectFiles = opts.fileNames !== undefined
      ? indexedFiles
      : this.program.getRootFileNames().map((fileName) => this.toRelative(fileName));
    this.projectFiles = new Set(projectFiles);
    this.absolutePathMap = new Map();
    for (const fileName of this.program.getRootFileNames()) {
      const rel = this.toRelative(fileName);
      this.absolutePathMap.set(rel, fileName);
    }
    for (const rel of projectFiles) {
      this.absolutePathMap.set(rel, this.toAbsolute(rel));
    }
  }

  extractNodes(filePath: string, source: string): { nodes: Node[]; errors: ExtractionError[] } {
    try {
      const scriptKind = scriptKindFromPath(filePath);
      const sourceFile = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );

      const lang = languageFromPath(filePath);
      const generated = isGenerated(filePath, source);
      const test = isTest(filePath);
      const nodes: Node[] = [];
      const errors: ExtractionError[] = [];

      nodes.push(this.makeFileNode(sourceFile, filePath, lang, generated, test));

      this.visitStatements(sourceFile, sourceFile, source, lang, generated, test, [], nodes, errors);

      nodes.sort(compareNodes);

      this.nodesByFile.set(filePath, nodes);

      return { nodes, errors };
    } catch (err) {
      return {
        nodes: [],
        errors: [{
          message: err instanceof Error ? err.message : String(err),
          filePath,
          severity: 'error',
          code: 'PARSE_ERROR',
        }],
      };
    }
  }

  resolveEdges(filePath: string): { edges: Edge[]; errors: ExtractionError[]; externalNodes: Node[] } {
    if (!this.program || !this.checker || !this.rootPath) {
      return { edges: [], errors: [], externalNodes: [] };
    }

    const absPath = this.absolutePathMap.get(filePath) ?? this.toAbsolute(filePath);
    const sourceFile = this.program.getSourceFile(absPath);
    if (!sourceFile) {
      return { edges: [], errors: [], externalNodes: [] };
    }

    const result = resolveEdgesForFile({
      program: this.program,
      checker: this.checker,
      sourceFile,
      filePath,
      project: this.project,
      hasher: this.hasher,
      projectFiles: this.projectFiles,
      rootPath: this.rootPath,
      now: this.now,
      nodesByFile: this.nodesByFile,
      loadNodesForFile: this.loadNodesForFile,
    });

    return { edges: result.edges, errors: result.errors, externalNodes: result.externalNodes };
  }

  private toAbsolute(relPath: string): string {
    return `${this.rootPath}/${relPath}`.replaceAll('//', '/');
  }

  private toRelative(absPath: string): string {
    const normalized = normalizeFsPath(absPath);
    const root = normalizeFsPath(this.rootPath!);
    if (normalized.startsWith(root + '/')) return normalized.slice(root.length + 1);
    return normalized;
  }

  private visitStatements(
    container: ts.Node,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nameParts: string[],
    nodes: Node[],
    errors: ExtractionError[],
  ): void {
    ts.forEachChild(container, (child) => {
      this.visitNode(child, sourceFile, source, lang, generated, test, nameParts, nodes, errors);
    });
  }

  private visitNode(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nameParts: string[],
    nodes: Node[],
    errors: ExtractionError[],
  ): void {
    if (ts.isFunctionDeclaration(node)) {
      this.handleFunctionDeclaration(node, sourceFile, source, lang, generated, test, nodes);
      return;
    }

    if (ts.isClassDeclaration(node)) {
      this.handleClassDeclaration(node, sourceFile, source, lang, generated, test, nodes, errors);
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      this.handleInterfaceDeclaration(node, sourceFile, source, lang, generated, test, nodes, errors);
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      this.handleEnumDeclaration(node, sourceFile, source, lang, generated, test, nodes);
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      this.handleTypeAliasDeclaration(node, sourceFile, source, lang, generated, test, nodes);
      return;
    }

    if (ts.isModuleDeclaration(node)) {
      this.handleModuleDeclaration(node, sourceFile, source, lang, generated, test, nameParts, nodes, errors);
      return;
    }

    if (ts.isVariableStatement(node)) {
      this.handleVariableStatement(node, sourceFile, source, lang, generated, test, nodes);
      return;
    }

    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      this.handleImportDeclaration(node, sourceFile, source, lang, generated, test, nodes);
      return;
    }

    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
      this.handleExportDeclaration(node, sourceFile, source, lang, generated, test, nodes);
      return;
    }
  }

  private handleFunctionDeclaration(
    node: ts.FunctionDeclaration,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nodes: Node[],
  ): void {
    const isDefault = hasDefaultModifier(node);
    const identity = computeNodeIdentity(node, sourceFile, this.project, this.hasher);
    const kind: NodeKind = isComponent(identity.name, node, sourceFile, lang) ? 'component' : 'function';

    nodes.push(this.buildNode({
      kind,
      identity,
      filePath: sourceFile.fileName,
      language: lang,
      node,
      sourceFile,
      source,
      generated,
      test,
      isExported: hasExportModifier(node) || isDefault,
      isAsync: hasAsyncModifier(node),
    }));
  }

  private handleClassDeclaration(
    node: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nodes: Node[],
    errors: ExtractionError[],
  ): void {
    const isDefault = hasDefaultModifier(node);
    const identity = computeNodeIdentity(node, sourceFile, this.project, this.hasher);

    nodes.push(this.buildNode({
      kind: 'class',
      identity,
      filePath: sourceFile.fileName,
      language: lang,
      node,
      sourceFile,
      source,
      generated,
      test,
      isExported: hasExportModifier(node) || isDefault,
      isAbstract: hasAbstractModifier(node),
    }));

    this.visitClassMembers(node, sourceFile, source, lang, generated, test, nodes, errors);
  }

  private visitClassMembers(
    classNode: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nodes: Node[],
    _errors: ExtractionError[],
  ): void {
    for (const member of classNode.members) {
      if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
        const identity = computeNodeIdentity(member, sourceFile, this.project, this.hasher);

        nodes.push(this.buildNode({
          kind: 'method',
          identity,
          filePath: sourceFile.fileName,
          language: lang,
          node: member,
          sourceFile,
          source,
          generated,
          test,
          isExported: false,
          isAsync: hasAsyncModifier(member),
          isStatic: hasStaticModifier(member),
          isAbstract: hasAbstractModifier(member),
          visibility: getVisibility(member),
        }));
      } else if (ts.isPropertyDeclaration(member)) {
        const identity = computeNodeIdentity(member, sourceFile, this.project, this.hasher);

        nodes.push(this.buildNode({
          kind: 'property',
          identity,
          filePath: sourceFile.fileName,
          language: lang,
          node: member,
          sourceFile,
          source,
          generated,
          test,
          isExported: false,
          isStatic: hasStaticModifier(member),
          isAbstract: hasAbstractModifier(member),
          visibility: getVisibility(member),
        }));
      } else if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
        const identity = computeNodeIdentity(member, sourceFile, this.project, this.hasher);

        const existing = nodes.find(
          (n) => n.qualifiedName === identity.qualifiedName && n.kind === 'property',
        );
        if (!existing) {
          nodes.push(this.buildNode({
            kind: 'property',
            identity,
            filePath: sourceFile.fileName,
            language: lang,
            node: member,
            sourceFile,
            source,
            generated,
            test,
            isExported: false,
            isStatic: hasStaticModifier(member),
            visibility: getVisibility(member),
            metadata: { accessor: ts.isGetAccessor(member) ? 'get' : 'set' },
          }));
        }
      }
    }
  }

  private handleInterfaceDeclaration(
    node: ts.InterfaceDeclaration,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nodes: Node[],
    _errors: ExtractionError[],
  ): void {
    const identity = computeNodeIdentity(node, sourceFile, this.project, this.hasher);

    nodes.push(this.buildNode({
      kind: 'interface',
      identity,
      filePath: sourceFile.fileName,
      language: lang,
      node,
      sourceFile,
      source,
      generated,
      test,
      isExported: hasExportModifier(node),
    }));

    for (const member of node.members) {
      if (ts.isMethodSignature(member)) {
        const memberIdentity = computeNodeIdentity(member, sourceFile, this.project, this.hasher);

        nodes.push(this.buildNode({
          kind: 'method',
          identity: memberIdentity,
          filePath: sourceFile.fileName,
          language: lang,
          node: member,
          sourceFile,
          source,
          generated,
          test,
          isExported: false,
        }));
      } else if (ts.isPropertySignature(member)) {
        const memberIdentity = computeNodeIdentity(member, sourceFile, this.project, this.hasher);

        nodes.push(this.buildNode({
          kind: 'property',
          identity: memberIdentity,
          filePath: sourceFile.fileName,
          language: lang,
          node: member,
          sourceFile,
          source,
          generated,
          test,
          isExported: false,
        }));
      }
    }
  }

  private handleEnumDeclaration(
    node: ts.EnumDeclaration,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nodes: Node[],
  ): void {
    const identity = computeNodeIdentity(node, sourceFile, this.project, this.hasher);

    nodes.push(this.buildNode({
      kind: 'enum',
      identity,
      filePath: sourceFile.fileName,
      language: lang,
      node,
      sourceFile,
      source,
      generated,
      test,
      isExported: hasExportModifier(node),
    }));

    for (const member of node.members) {
      const memberIdentity = computeNodeIdentity(member, sourceFile, this.project, this.hasher);

      nodes.push(this.buildNode({
        kind: 'enum_member',
        identity: memberIdentity,
        filePath: sourceFile.fileName,
        language: lang,
        node: member,
        sourceFile,
        source,
        generated,
        test,
        isExported: false,
      }));
    }
  }

  private handleTypeAliasDeclaration(
    node: ts.TypeAliasDeclaration,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nodes: Node[],
  ): void {
    const identity = computeNodeIdentity(node, sourceFile, this.project, this.hasher);

    nodes.push(this.buildNode({
      kind: 'type_alias',
      identity,
      filePath: sourceFile.fileName,
      language: lang,
      node,
      sourceFile,
      source,
      generated,
      test,
      isExported: hasExportModifier(node),
    }));
  }

  private handleModuleDeclaration(
    node: ts.ModuleDeclaration,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nameParts: string[],
    nodes: Node[],
    errors: ExtractionError[],
  ): void {
    const identity = computeNodeIdentity(node, sourceFile, this.project, this.hasher);

    nodes.push(this.buildNode({
      kind: 'namespace',
      identity,
      filePath: sourceFile.fileName,
      language: lang,
      node,
      sourceFile,
      source,
      generated,
      test,
      isExported: hasExportModifier(node),
    }));

    if (node.body && ts.isModuleBlock(node.body)) {
      this.visitStatements(node.body, sourceFile, source, lang, generated, test, nameParts, nodes, errors);
    }
  }

  private handleVariableStatement(
    stmt: ts.VariableStatement,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nodes: Node[],
  ): void {
    const isStmtExported = hasExportModifier(stmt);

    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;

      const identity = computeNodeIdentity(decl, sourceFile, this.project, this.hasher);
      const init = decl.initializer;

      let kind: NodeKind = identity.kind;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        kind = isComponent(identity.name, init, sourceFile, lang, decl) ? 'component' : 'function';
      }

      nodes.push(this.buildNode({
        kind,
        identity,
        filePath: sourceFile.fileName,
        language: lang,
        node: stmt,
        sourceFile,
        source,
        generated,
        test,
        isExported: isStmtExported,
        isAsync: init !== undefined && ts.isArrowFunction(init) && hasAsyncModifier(init),
      }));
    }
  }

  private handleImportDeclaration(
    node: ts.ImportDeclaration | ts.ImportEqualsDeclaration,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nodes: Node[],
  ): void {
    const identity = computeNodeIdentity(node, sourceFile, this.project, this.hasher);

    nodes.push(this.buildNode({
      kind: 'import',
      identity,
      filePath: sourceFile.fileName,
      language: lang,
      node,
      sourceFile,
      source,
      generated,
      test,
      isExported: false,
    }));
  }

  private handleExportDeclaration(
    node: ts.ExportDeclaration | ts.ExportAssignment,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nodes: Node[],
  ): void {
    const identity = computeNodeIdentity(node, sourceFile, this.project, this.hasher);

    nodes.push(this.buildNode({
      kind: 'export',
      identity,
      filePath: sourceFile.fileName,
      language: lang,
      node,
      sourceFile,
      source,
      generated,
      test,
      isExported: true,
    }));
  }

  private makeFileNode(
    sourceFile: ts.SourceFile,
    filePath: string,
    lang: Language,
    generated: boolean,
    test: boolean,
  ): Node {
    const qualifiedName = filePath;
    const pos = sourceFile.getLineAndCharacterOfPosition(sourceFile.getStart());
    const end = sourceFile.getLineAndCharacterOfPosition(sourceFile.getEnd());
    const basename = filePath.split('/').pop() ?? filePath;

    return {
      id: makeNodeId({
        project: this.project,
        filePath,
        kind: 'file',
        qualifiedName,
      }, this.hasher),
      project: this.project,
      kind: 'file',
      name: basename,
      qualifiedName,
      filePath,
      language: lang,
      range: {
        startLine: pos.line + 1,
        endLine: end.line + 1,
        startColumn: pos.character,
        endColumn: end.character,
      },
      isExported: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      isExternal: false,
      isGenerated: generated,
      isTest: test,
      updatedAt: this.now(),
    };
  }

  private buildNode(input: {
    kind: NodeKind;
    identity: { id: string; name: string; qualifiedName: string; signature: string; locator?: string };
    filePath: string;
    language: Language;
    node: ts.Node;
    sourceFile: ts.SourceFile;
    source: string;
    generated: boolean;
    test: boolean;
    isExported: boolean;
    isAsync?: boolean;
    isStatic?: boolean;
    isAbstract?: boolean;
    visibility?: Node['visibility'];
    metadata?: Record<string, unknown>;
  }): Node {
    const { kind, identity, filePath, language, node: astNode, sourceFile, source } = input;
    const range = getRange(astNode, sourceFile);
    const docstring = extractDocstring(astNode, sourceFile, source);
    const decorators = extractDecorators(astNode, sourceFile);
    const typeParams = extractTypeParameters(astNode);

    return {
      id: makeNodeId({
        project: this.project,
        filePath,
        kind,
        qualifiedName: identity.qualifiedName,
        locator: identity.locator,
      }, this.hasher),
      project: this.project,
      kind,
      name: identity.name,
      qualifiedName: identity.qualifiedName,
      filePath,
      language,
      range,
      signature: identity.signature || undefined,
      docstring: docstring || undefined,
      visibility: input.visibility,
      isExported: input.isExported,
      isAsync: input.isAsync ?? false,
      isStatic: input.isStatic ?? false,
      isAbstract: input.isAbstract ?? false,
      isExternal: false,
      isGenerated: input.generated,
      isTest: input.test,
      decorators: decorators.length > 0 ? decorators : undefined,
      typeParameters: typeParams.length > 0 ? typeParams : undefined,
      metadata: input.metadata,
      updatedAt: this.now(),
    };
  }
}

function normalizeFsPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('/private/var/') ? normalized.slice('/private'.length) : normalized;
}

function findConfigFile(rootPath: string): string | undefined {
  const tsconfig = ts.findConfigFile(rootPath, ts.sys.fileExists, 'tsconfig.json');
  if (tsconfig) return tsconfig;
  const jsconfig = ts.findConfigFile(rootPath, ts.sys.fileExists, 'jsconfig.json');
  return jsconfig;
}

function normalizeIndexedFiles(fileNames: string[] | undefined, rootPath: string): string[] {
  if (fileNames === undefined) return [];
  const root = rootPath.replaceAll('\\', '/').replace(/\/$/, '');
  return uniqueStrings(fileNames.map((fileName) => {
    const normalized = fileName.replaceAll('\\', '/');
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
    return normalized.replace(/^\.\//, '');
  }));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort(compareStr);
}

function scriptKindFromPath(filePath: string): ts.ScriptKind {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function isComponent(
  name: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  lang: Language,
  varDecl?: ts.VariableDeclaration,
): boolean {
  if (!isPascalCase(name)) return false;

  const isJsxFile = lang === 'tsx' || lang === 'jsx';
  if (isJsxFile && containsJsx(node, sourceFile)) return true;

  if (hasReactFCTyping(node)) return true;
  if (varDecl && hasReactFCTyping(varDecl)) return true;

  return false;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

function containsJsx(node: ts.Node, _sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function hasReactFCTyping(node: ts.Node): boolean {
  const typeNode = (node as ts.FunctionDeclaration | ts.VariableDeclaration).type;
  if (!typeNode) return false;
  const text = typeNode.getText();
  return text.includes('React.FC') || text.includes('FunctionComponent') || text.includes('React.FunctionComponent');
}

function compareNodes(a: Node, b: Node): number {
  return compareStr(a.filePath, b.filePath)
    || a.range.startLine - b.range.startLine
    || compareStr(a.kind, b.kind)
    || compareStr(a.qualifiedName, b.qualifiedName);
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
