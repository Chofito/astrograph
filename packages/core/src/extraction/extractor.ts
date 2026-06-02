import ts from 'typescript';
import type {
  Extractor,
  Node,
  Edge,
  ExtractionError,
  Hasher,
  NodeKind,
  Language,
  Range,
} from '../types';
import { makeNodeId } from '../ids';
import { languageFromPath } from './language';
import { isGenerated, isTest } from './classify';
import { buildQualifiedName, buildSignatureLocator } from './qualified-name';

export interface TsExtractorOptions {
  hasher: Hasher;
  now?: () => number;
  project?: string;
}

export class TsExtractor implements Extractor {
  private readonly hasher: Hasher;
  private readonly now: () => number;
  private readonly project: string;

  constructor(opts: TsExtractorOptions) {
    this.hasher = opts.hasher;
    this.now = opts.now ?? Date.now;
    this.project = opts.project ?? 'root';
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

      this.disambiguateOverloads(nodes);

      nodes.sort(compareNodes);
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

  resolveEdges(_filePath: string): { edges: Edge[]; errors: ExtractionError[] } {
    // TODO(pass-b): implement edge resolution
    return { edges: [], errors: [] };
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
      this.handleFunctionDeclaration(node, sourceFile, source, lang, generated, test, nameParts, nodes);
      return;
    }

    if (ts.isClassDeclaration(node)) {
      this.handleClassDeclaration(node, sourceFile, source, lang, generated, test, nameParts, nodes, errors);
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      this.handleInterfaceDeclaration(node, sourceFile, source, lang, generated, test, nameParts, nodes, errors);
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      this.handleEnumDeclaration(node, sourceFile, source, lang, generated, test, nameParts, nodes);
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      this.handleTypeAliasDeclaration(node, sourceFile, source, lang, generated, test, nameParts, nodes);
      return;
    }

    if (ts.isModuleDeclaration(node)) {
      this.handleModuleDeclaration(node, sourceFile, source, lang, generated, test, nameParts, nodes, errors);
      return;
    }

    if (ts.isVariableStatement(node)) {
      this.handleVariableStatement(node, sourceFile, source, lang, generated, test, nameParts, nodes);
      return;
    }

    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      this.handleImportDeclaration(node, sourceFile, source, lang, generated, test, nameParts, nodes);
      return;
    }

    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
      this.handleExportDeclaration(node, sourceFile, source, lang, generated, test, nameParts, nodes);
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
    nameParts: string[],
    nodes: Node[],
  ): void {
    const isDefault = hasDefaultModifier(node);
    const name = node.name?.text ?? (isDefault ? 'default' : '<anonymous>');
    const parts = [...nameParts, name];
    const qualifiedName = buildQualifiedName({ filePath: sourceFile.fileName, parts });
    const kind: NodeKind = isComponent(name, node, sourceFile, lang) ? 'component' : 'function';

    nodes.push(this.buildNode({
      kind,
      name,
      qualifiedName,
      filePath: sourceFile.fileName,
      language: lang,
      node: node,
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
    nameParts: string[],
    nodes: Node[],
    errors: ExtractionError[],
  ): void {
    const isDefault = hasDefaultModifier(node);
    const name = node.name?.text ?? (isDefault ? 'default' : '<anonymous>');
    const parts = [...nameParts, name];
    const qualifiedName = buildQualifiedName({ filePath: sourceFile.fileName, parts });

    nodes.push(this.buildNode({
      kind: 'class',
      name,
      qualifiedName,
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

    this.visitClassMembers(node, sourceFile, source, lang, generated, test, parts, nodes, errors);
  }

  private visitClassMembers(
    classNode: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    classNameParts: string[],
    nodes: Node[],
    _errors: ExtractionError[],
  ): void {
    for (const member of classNode.members) {
      if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
        const name = ts.isConstructorDeclaration(member)
          ? 'constructor'
          : member.name?.getText(sourceFile) ?? '<anonymous>';
        const parts = [...classNameParts, name];
        const qualifiedName = buildQualifiedName({ filePath: sourceFile.fileName, parts });

        nodes.push(this.buildNode({
          kind: 'method',
          name,
          qualifiedName,
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
        const name = member.name?.getText(sourceFile) ?? '<anonymous>';
        const parts = [...classNameParts, name];
        const qualifiedName = buildQualifiedName({ filePath: sourceFile.fileName, parts });

        nodes.push(this.buildNode({
          kind: 'property',
          name,
          qualifiedName,
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
        const name = member.name?.getText(sourceFile) ?? '<anonymous>';
        const parts = [...classNameParts, name];
        const qualifiedName = buildQualifiedName({ filePath: sourceFile.fileName, parts });

        const existing = nodes.find(
          (n) => n.qualifiedName === qualifiedName && n.kind === 'property',
        );
        if (!existing) {
          nodes.push(this.buildNode({
            kind: 'property',
            name,
            qualifiedName,
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
    nameParts: string[],
    nodes: Node[],
    _errors: ExtractionError[],
  ): void {
    const name = node.name.text;
    const parts = [...nameParts, name];
    const qualifiedName = buildQualifiedName({ filePath: sourceFile.fileName, parts });

    nodes.push(this.buildNode({
      kind: 'interface',
      name,
      qualifiedName,
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
        const memberName = member.name?.getText(sourceFile) ?? '<anonymous>';
        const memberParts = [...parts, memberName];
        const memberQName = buildQualifiedName({ filePath: sourceFile.fileName, parts: memberParts });

        nodes.push(this.buildNode({
          kind: 'method',
          name: memberName,
          qualifiedName: memberQName,
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
        const memberName = member.name?.getText(sourceFile) ?? '<anonymous>';
        const memberParts = [...parts, memberName];
        const memberQName = buildQualifiedName({ filePath: sourceFile.fileName, parts: memberParts });

        nodes.push(this.buildNode({
          kind: 'property',
          name: memberName,
          qualifiedName: memberQName,
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
    nameParts: string[],
    nodes: Node[],
  ): void {
    const name = node.name.text;
    const parts = [...nameParts, name];
    const qualifiedName = buildQualifiedName({ filePath: sourceFile.fileName, parts });

    nodes.push(this.buildNode({
      kind: 'enum',
      name,
      qualifiedName,
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
      const memberName = member.name.getText(sourceFile);
      const memberParts = [...parts, memberName];
      const memberQName = buildQualifiedName({ filePath: sourceFile.fileName, parts: memberParts });

      nodes.push(this.buildNode({
        kind: 'enum_member',
        name: memberName,
        qualifiedName: memberQName,
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
    nameParts: string[],
    nodes: Node[],
  ): void {
    const name = node.name.text;
    const parts = [...nameParts, name];
    const qualifiedName = buildQualifiedName({ filePath: sourceFile.fileName, parts });

    nodes.push(this.buildNode({
      kind: 'type_alias',
      name,
      qualifiedName,
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
    const name = node.name.getText(sourceFile);
    const parts = [...nameParts, name];
    const qualifiedName = buildQualifiedName({ filePath: sourceFile.fileName, parts });

    nodes.push(this.buildNode({
      kind: 'namespace',
      name,
      qualifiedName,
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
      this.visitStatements(node.body, sourceFile, source, lang, generated, test, parts, nodes, errors);
    }
  }

  private handleVariableStatement(
    stmt: ts.VariableStatement,
    sourceFile: ts.SourceFile,
    source: string,
    lang: Language,
    generated: boolean,
    test: boolean,
    nameParts: string[],
    nodes: Node[],
  ): void {
    const isStmtExported = hasExportModifier(stmt);
    const flags = stmt.declarationList.flags;
    const isConst = (flags & ts.NodeFlags.Const) !== 0;

    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;

      const name = decl.name.text;
      const init = decl.initializer;

      let kind: NodeKind;
      let declNode: ts.Node = decl;

      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        kind = isComponent(name, init, sourceFile, lang, decl) ? 'component' : 'function';
        declNode = stmt;
      } else if (init && ts.isClassExpression(init)) {
        kind = 'class';
        declNode = stmt;
      } else if (isConst) {
        kind = 'constant';
        declNode = stmt;
      } else {
        kind = 'variable';
        declNode = stmt;
      }

      const parts = [...nameParts, name];
      const qualifiedName = buildQualifiedName({ filePath: sourceFile.fileName, parts });

      nodes.push(this.buildNode({
        kind,
        name,
        qualifiedName,
        filePath: sourceFile.fileName,
        language: lang,
        node: declNode,
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
    nameParts: string[],
    nodes: Node[],
  ): void {
    let moduleName: string;
    if (ts.isImportDeclaration(node)) {
      moduleName = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : node.moduleSpecifier.getText(sourceFile);
    } else {
      moduleName = node.moduleReference.getText(sourceFile);
    }

    const parts = [...nameParts, `import(${moduleName})`];
    const qualifiedName = buildQualifiedName({ filePath: sourceFile.fileName, parts });

    nodes.push(this.buildNode({
      kind: 'import',
      name: moduleName,
      qualifiedName,
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
    nameParts: string[],
    nodes: Node[],
  ): void {
    let name: string;
    if (ts.isExportAssignment(node)) {
      name = 'default';
    } else if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      name = `re-export(${node.moduleSpecifier.text})`;
    } else if (node.exportClause) {
      name = node.exportClause.getText(sourceFile);
    } else {
      name = node.getText(sourceFile).slice(0, 40);
    }

    const parts = [...nameParts, `export(${name})`];
    const qualifiedName = buildQualifiedName({ filePath: sourceFile.fileName, parts });

    nodes.push(this.buildNode({
      kind: 'export',
      name,
      qualifiedName,
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
    name: string;
    qualifiedName: string;
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
    locator?: string;
  }): Node {
    const { kind, name, qualifiedName, filePath, language, node: astNode, sourceFile, source } = input;
    const range = getRange(astNode, sourceFile);
    const signature = extractSignature(astNode, sourceFile);
    const docstring = extractDocstring(astNode, sourceFile, source);
    const decorators = extractDecorators(astNode, sourceFile);
    const typeParams = extractTypeParameters(astNode);

    return {
      id: makeNodeId({
        project: this.project,
        filePath,
        kind,
        qualifiedName,
        locator: input.locator,
      }, this.hasher),
      project: this.project,
      kind,
      name,
      qualifiedName,
      filePath,
      language,
      range,
      signature: signature || undefined,
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

  private disambiguateOverloads(nodes: Node[]): void {
    const groups = new Map<string, Node[]>();
    for (const node of nodes) {
      const key = `${node.kind}::${node.qualifiedName}`;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(node);
    }

    for (const group of groups.values()) {
      if (group.length <= 1) continue;

      group.sort((a, b) => a.range.startLine - b.range.startLine);

      const hashCounts = new Map<string, number>();
      for (const node of group) {
        const sigHash = this.hasher.hash(node.signature ?? '');
        hashCounts.set(sigHash, (hashCounts.get(sigHash) ?? 0) + 1);
      }

      const ordinalCounters = new Map<string, number>();
      for (const node of group) {
        const sigHash = this.hasher.hash(node.signature ?? '');
        const needsOrdinal = (hashCounts.get(sigHash) ?? 0) > 1;
        const ordinal = ordinalCounters.get(sigHash) ?? 0;
        ordinalCounters.set(sigHash, ordinal + 1);

        const locator = needsOrdinal
          ? `sig:${sigHash}:${ordinal}`
          : `sig:${sigHash}`;

        node.id = makeNodeId({
          project: this.project,
          filePath: node.filePath,
          kind: node.kind,
          qualifiedName: node.qualifiedName,
          locator,
        }, this.hasher);
      }
    }
  }
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

function getRange(node: ts.Node, sourceFile: ts.SourceFile): Range {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    endLine: end.line + 1,
    startColumn: start.character,
    endColumn: end.character,
  };
}

function extractSignature(node: ts.Node, sourceFile: ts.SourceFile): string {
  const start = node.getStart(sourceFile);
  const text = sourceFile.text;

  const body = (node as ts.FunctionDeclaration | ts.MethodDeclaration).body;
  if (body && ts.isBlock(body)) {
    return collapse(text.slice(start, body.getStart(sourceFile)));
  }

  if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    const fullText = text.slice(start, node.getEnd());
    const braceIdx = fullText.indexOf('{');
    if (braceIdx !== -1) return collapse(fullText.slice(0, braceIdx));
  }

  if (ts.isTypeAliasDeclaration(node)) {
    return collapse(node.getText(sourceFile));
  }

  if (ts.isVariableStatement(node)) {
    return collapse(node.getText(sourceFile));
  }

  if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
    return collapse(node.getText(sourceFile));
  }

  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    return collapse(node.getText(sourceFile));
  }

  if (ts.isEnumMember(node)) {
    return collapse(node.getText(sourceFile));
  }

  return collapse(node.getText(sourceFile));
}

function collapse(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function extractDocstring(node: ts.Node, sourceFile: ts.SourceFile, source: string): string | undefined {
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart());
  if (!ranges || ranges.length === 0) return undefined;

  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i]!;
    const commentText = source.slice(range.pos, range.end);
    if (commentText.startsWith('/**')) {
      return cleanJSDoc(commentText);
    }
  }

  return undefined;
}

function cleanJSDoc(text: string): string {
  return text
    .replace(/^\/\*\*\s?/, '')
    .replace(/\s?\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
}

function extractDecorators(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  if (!ts.canHaveDecorators(node)) return [];
  const decorators = ts.getDecorators(node);
  if (!decorators) return [];
  return decorators.map((d) => d.expression.getText(sourceFile));
}

function extractTypeParameters(node: ts.Node): string[] {
  const tp = (node as ts.FunctionDeclaration | ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration).typeParameters;
  if (!tp) return [];
  return tp.map((p) => p.name.text);
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

function hasAsyncModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

function hasStaticModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
}

function hasAbstractModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) ?? false;
}

function getVisibility(node: ts.Node): Node['visibility'] {
  if (!ts.canHaveModifiers(node)) return undefined;
  const modifiers = ts.getModifiers(node);
  if (!modifiers) return undefined;
  for (const m of modifiers) {
    if (m.kind === ts.SyntaxKind.PublicKeyword) return 'public';
    if (m.kind === ts.SyntaxKind.PrivateKeyword) return 'private';
    if (m.kind === ts.SyntaxKind.ProtectedKeyword) return 'protected';
  }
  return undefined;
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
