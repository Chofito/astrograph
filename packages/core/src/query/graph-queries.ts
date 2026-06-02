import type {
  CallersInput,
  CallersOutput,
  CalleesInput,
  CalleesOutput,
  CodeBlock,
  ContextInput,
  ContextOutput,
  Edge,
  EdgeKind,
  EdgeRef,
  ExploreInput,
  ExploreOutput,
  FileEntry,
  FileSystem,
  FilesInput,
  FilesOutput,
  ImpactInput,
  ImpactOutput,
  Node,
  NodeInput,
  NodeOutput,
  NodeRef,
  SearchInput,
  SearchOutput,
  StatusInput,
  StatusOutput,
  ToolMeta,
  ToolResult,
  TraceInput,
  TraceOutput,
} from '../types';
import { AstrographError as CoreError } from '../types';
import { QueryBuilder, toEdgeRef, toNodeRef } from '../db/queries';
import { findPath, traverseGraph } from '../graph/traversal';
import { resolveSymbol, type SymbolLookupResult } from '../graph/symbol-lookup';
import { CodeBlockSlicer } from './code-blocks';
import { buildMeta } from './meta';

export interface GraphQueriesOptions {
  queries: QueryBuilder;
  fs: FileSystem;
  root: string;
  project?: string;
}

export class GraphQueries {
  private readonly queries: QueryBuilder;
  private readonly slicer: CodeBlockSlicer;

  constructor(options: GraphQueriesOptions) {
    this.queries = options.queries;
    this.slicer = new CodeBlockSlicer({ fs: options.fs, root: options.root });
  }

  async search(input: SearchInput): Promise<ToolResult<SearchOutput>> {
    const data = this.queries.search({ ...input, limit: input.limit ?? 10 });
    const notes = ambiguityNotes([], data.map((result) => result.node.name));
    return { data, meta: this.meta({ notes }) };
  }

  async context(input: ContextInput): Promise<ToolResult<ContextOutput>> {
    const maxSymbols = input.maxSymbols ?? 20;
    const entryResults = this.queries.search({
      query: input.task,
      limit: Math.max(maxSymbols, 10),
      includeGenerated: true,
    });
    const entryNodes = entryResults
      .map((result) => this.queries.getNode(result.node.id))
      .filter((node): node is Node => node !== undefined);
    const entryIds = new Set(entryNodes.map((node) => node.id));
    const ftsScores = normalizedFtsScores(entryResults);

    const candidates = new Map<string, ContextCandidate>();
    for (const node of entryNodes) {
      candidates.set(node.id, { node, distance: 0, reason: 'fts-match' });
    }

    const traversalLimit = Math.max(maxSymbols * 20, 100);
    for (const entry of entryNodes) {
      for (const direction of ['outgoing', 'incoming'] as const) {
        const visits = traverseGraph(this.queries, {
          startId: entry.id,
          direction,
          edgeKinds: CONTEXT_EDGE_KINDS,
          maxDepth: 2,
          limit: traversalLimit,
        });
        for (const visit of visits) {
          const reason = entryIds.has(visit.node.id) ? 'fts-match' : this.contextReason(visit, direction);
          const current = candidates.get(visit.node.id);
          if (
            current === undefined
            || visit.distance < current.distance
            || (visit.distance === current.distance && compareStrings(reason, current.reason) < 0)
          ) {
            candidates.set(visit.node.id, { node: visit.node, distance: visit.distance, reason });
          }
        }
      }
    }

    const degreeScores = normalizedDegreeScores(this.queries, [...candidates.values()].map((candidate) => candidate.node));
    const ranked = [...candidates.values()]
      .map((candidate) => ({
        ...candidate,
        score: contextScore(candidate, {
          fts: ftsScores.get(candidate.node.id) ?? 0,
          centrality: degreeScores.get(candidate.node.id) ?? 0,
        }),
      }))
      .sort(compareContextCandidates)
      .slice(0, maxSymbols);

    const includedIds = new Set(ranked.map((candidate) => candidate.node.id));
    const nodes = ranked.map((candidate) => toNodeRef(candidate.node));
    const edgeRows = this.contextEdgesAmong(includedIds);
    const edges = sortEdgeRefs(edgeRows.map(toEdgeRef));
    const codeBlocks = input.includeCode === false
      ? []
      : await this.contextCodeBlocks(ranked.map((candidate) => candidate.node), input.tokenBudget);
    const relatedFiles = filesForNodes(ranked.map((candidate) => candidate.node));
    const totalCodeChars = codeBlocks.reduce((sum, block) => sum + block.content.length, 0);
    const inclusionReasons = Object.fromEntries(
      ranked.map((candidate) => [candidate.node.id, candidate.reason]),
    );

    return {
      data: {
        entryPoints: entryNodes.filter((node) => includedIds.has(node.id)).map(toNodeRef),
        subgraph: { nodes, edges },
        codeBlocks,
        inclusionReasons,
        relatedFiles,
        stats: {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          fileCount: relatedFiles.length,
          codeBlockCount: codeBlocks.length,
          totalCodeChars,
        },
      },
      meta: this.meta({
        scopeFiles: relatedFiles,
        notes: edgeNotes(edgeRows),
      }),
    };
  }

  async getNode(input: NodeInput): Promise<ToolResult<NodeOutput>> {
    const lookup = this.resolveOrThrow(input.symbol);
    const node = lookup.best;
    const callersEdges = this.queries.getEdgesByTarget(node.id, 'calls');
    const calleesEdges = [
      ...this.queries.getEdgesBySource(node.id, 'calls'),
      ...this.queries.getEdgesBySource(node.id, 'instantiates'),
    ];

    const callersPreview = this.refsForEdgeNodes(callersEdges, 'source').slice(0, 5);
    const calleesPreview = this.refsForEdgeNodes(calleesEdges, 'target').slice(0, 5);
    const code = input.includeCode === true ? await this.slicer.sliceNode(node) : undefined;
    const data: NodeOutput = {
      node: toNodeRef(node),
      docstring: node.docstring,
      callersPreview,
      calleesPreview,
      code,
    };

    return {
      data,
      meta: this.meta({
        scopeFiles: [node.filePath],
        notes: [
          ...this.ambiguityLookupNotes(lookup),
          ...edgeNotes([...callersEdges, ...calleesEdges]),
        ],
      }),
    };
  }

  async callers(input: CallersInput): Promise<ToolResult<CallersOutput>> {
    const lookup = this.resolveOrThrow(input.symbol);
    const limit = input.limit ?? 20;
    const edges = this.queries.getEdgesByTarget(lookup.best.id, 'calls');
    const data = sortCallerOutputs(edges
      .map((edge) => {
        const caller = this.queries.getNode(edge.source);
        return caller === undefined ? undefined : { caller: toNodeRef(caller), callSite: toEdgeRef(edge) };
      })
      .filter((result): result is CallersOutput[number] => result !== undefined))
      .slice(0, limit);

    return {
      data,
      meta: this.meta({
        forcePartial: !this.isFullyResolved(),
        notes: [...this.ambiguityLookupNotes(lookup), ...edgeNotes(edges)],
      }),
    };
  }

  async callees(input: CalleesInput): Promise<ToolResult<CalleesOutput>> {
    const lookup = this.resolveOrThrow(input.symbol);
    const limit = input.limit ?? 20;
    const edges = [
      ...this.queries.getEdgesBySource(lookup.best.id, 'calls'),
      ...this.queries.getEdgesBySource(lookup.best.id, 'instantiates'),
    ];
    const data = sortCalleeOutputs(edges
      .map((edge) => {
        if (edge.target === null) return undefined;
        const callee = this.queries.getNode(edge.target);
        return callee === undefined ? undefined : { callee: toNodeRef(callee), callSite: toEdgeRef(edge) };
      })
      .filter((result): result is CalleesOutput[number] => result !== undefined))
      .slice(0, limit);

    return {
      data,
      meta: this.meta({
        scopeFiles: [lookup.best.filePath],
        notes: [...this.ambiguityLookupNotes(lookup), ...edgeNotes(edges)],
      }),
    };
  }

  async impact(input: ImpactInput): Promise<ToolResult<ImpactOutput>> {
    const lookup = this.resolveOrThrow(input.symbol);
    const visits = traverseGraph(this.queries, {
      startId: lookup.best.id,
      direction: 'incoming',
      edgeKinds: ['calls', 'references', 'imports', 'extends', 'implements'],
      maxDepth: input.depth ?? 2,
      limit: 250,
    });

    const data = visits
      .filter((visit) => visit.distance > 0)
      .filter((visit) => input.includeExternal === true || !visit.node.isExternal)
      .map((visit) => ({
        node: toNodeRef(visit.node),
        distance: visit.distance,
        viaPath: visit.path.map(toEdgeRef),
      }))
      .sort(compareImpactOutputs);

    return {
      data,
      meta: this.meta({
        forcePartial: !this.isFullyResolved(),
        notes: [
          ...this.ambiguityLookupNotes(lookup),
          ...edgeNotes(visits.flatMap((visit) => visit.path)),
        ],
      }),
    };
  }

  async trace(input: TraceInput): Promise<ToolResult<TraceOutput>> {
    const from = this.resolveOrThrow(input.from);
    const to = this.resolveOrThrow(input.to);
    const path = findPath(this.queries, {
      startId: from.best.id,
      targetId: to.best.id,
      direction: 'outgoing',
      edgeKinds: ['calls', 'references'],
      maxDepth: input.maxDepth ?? 6,
    });

    if (path !== undefined) {
      const hops = await Promise.all(path.map(async (edge) => {
        const source = this.queries.getNode(edge.source);
        if (source === undefined) return undefined;
        return { node: toNodeRef(source), via: toEdgeRef(edge), body: await this.slicer.sliceNode(source) };
      }));
      const destinationCallees = this.refsForEdgeNodes([
        ...this.queries.getEdgesBySource(to.best.id, 'calls'),
        ...this.queries.getEdgesBySource(to.best.id, 'instantiates'),
      ], 'target');

      return {
        data: {
          found: true,
          hops: hops.filter((hop): hop is TraceOutput['hops'][number] => hop !== undefined),
          destinationCallees,
        },
        meta: this.meta({
          scopeFiles: filesForNodes([from.best, to.best, ...this.nodesForEdges(path)]),
          notes: [
            ...this.ambiguityLookupNotes(from, 'from'),
            ...this.ambiguityLookupNotes(to, 'to'),
            ...edgeNotes(path),
          ],
        }),
      };
    }

    const inlineNodes = this.traceFallbackNodes(from.best, to.best);
    const endpoints = await Promise.all(inlineNodes.map(async (node) => ({
      node: toNodeRef(node),
      body: await this.slicer.sliceNode(node),
    })));

    return {
      data: { found: false, hops: [], endpoints },
      meta: this.meta({
        scopeFiles: filesForNodes(inlineNodes),
        notes: [
          'No calls/references path found within maxDepth',
          ...this.ambiguityLookupNotes(from, 'from'),
          ...this.ambiguityLookupNotes(to, 'to'),
        ],
      }),
    };
  }

  async explore(input: ExploreInput): Promise<ToolResult<ExploreOutput>> {
    const maxFiles = input.maxFiles ?? 12;
    const terms = input.query.split(/\s+/).map((term) => term.trim()).filter((term) => term !== '');
    const nodes = uniqueNodes(terms.flatMap((term) => resolveSymbol(this.queries, term).candidates));
    const nodesByFile = groupNodesByFile(nodes, maxFiles);
    const files = await Promise.all([...nodesByFile.entries()].map(async ([filePath, fileNodes]) => ({
      filePath,
      blocks: await Promise.all(fileNodes.map((node) => this.slicer.sliceNode(node))),
    })));
    const includedIds = new Set([...nodesByFile.values()].flat().map((node) => node.id));
    const relationshipMap = this.relationshipsAmong(includedIds);

    return {
      data: {
        files: files.sort(compareExploreFiles),
        relationshipMap,
      },
      meta: this.meta({
        scopeFiles: [...nodesByFile.keys()],
        notes: terms.length === 0 ? ['Empty explore query'] : undefined,
      }),
    };
  }

  async getFiles(input: FilesInput): Promise<ToolResult<FilesOutput>> {
    const format = input.format ?? 'tree';
    const pathPrefix = input.path?.replace(/\/$/, '');
    const entries = this.queries.getAllFiles()
      .filter((file) => pathPrefix === undefined || file.path === pathPrefix || file.path.startsWith(`${pathPrefix}/`))
      .filter((file) => input.pattern === undefined || matchesPattern(file.path, input.pattern))
      .filter((file) => input.maxDepth === undefined || pathDepth(file.path) <= input.maxDepth)
      .map((file): FileEntry => ({
        filePath: file.path,
        language: file.language,
        nodeCount: file.nodeCount,
        coverageState: file.state,
      }))
      .sort(compareFileEntries);

    return { data: { format, entries }, meta: this.meta() };
  }

  async getStats(_input: StatusInput): Promise<ToolResult<StatusOutput>> {
    const data = this.queries.getStats();
    return { data, meta: this.meta() };
  }

  private resolveOrThrow(symbol: string): SymbolLookupResult & { best: Node } {
    const lookup = resolveSymbol(this.queries, symbol);
    if (lookup.best === undefined) {
      throw new CoreError(`Symbol not found: ${symbol}`, 'NOT_FOUND');
    }
    return lookup as SymbolLookupResult & { best: Node };
  }

  private refsForEdgeNodes(edges: Edge[], side: 'source' | 'target'): NodeRef[] {
    const refs = edges
      .map((edge) => {
        const id = side === 'source' ? edge.source : edge.target;
        return id === null ? undefined : this.queries.getNode(id);
      })
      .filter((node): node is Node => node !== undefined)
      .map(toNodeRef);
    return sortNodeRefs(uniqueNodeRefs(refs));
  }

  private relationshipsAmong(nodeIds: Set<string>): EdgeRef[] {
    const edges = [...nodeIds].flatMap((id) => this.queries.getEdgesBySource(id))
      .filter((edge) => edge.target !== null && nodeIds.has(edge.target))
      .filter((edge) => edge.kind !== 'contains' && edge.kind !== 'exports');
    return sortEdgeRefs(edges.map(toEdgeRef));
  }

  private contextEdgesAmong(nodeIds: Set<string>): Edge[] {
    const kinds = new Set<EdgeKind>(CONTEXT_EDGE_KINDS);
    return [...nodeIds].flatMap((id) => this.queries.getEdgesBySource(id))
      .filter((edge) => edge.target !== null && nodeIds.has(edge.target))
      .filter((edge) => kinds.has(edge.kind));
  }

  private async contextCodeBlocks(nodes: Node[], tokenBudget: number | undefined): Promise<CodeBlock[]> {
    const blocks: CodeBlock[] = [];
    let usedTokens = 0;
    for (const node of nodes) {
      if (node.isExternal) continue;
      const block = await this.slicer.sliceNode(node);
      const tokens = Math.ceil(block.content.length / 4);
      if (tokenBudget !== undefined && usedTokens + tokens > tokenBudget) continue;
      blocks.push(block);
      usedTokens += tokens;
    }
    return blocks;
  }

  private contextReason(visit: { node: Node; distance: number; path: Edge[] }, direction: 'outgoing' | 'incoming'): string {
    const edge = visit.path.at(-1);
    if (edge === undefined) return 'fts-match';
    const source = this.queries.getNode(edge.source);
    const target = edge.target === null ? undefined : this.queries.getNode(edge.target);
    const sourceName = source?.name ?? edge.source;
    const targetName = target?.name ?? edge.targetName ?? edge.target ?? 'unknown';

    if (direction === 'outgoing') {
      if (edge.kind === 'calls') return `called-by:${sourceName}`;
      if (edge.kind === 'imports') return `imported-by:${sourceName}`;
      if (edge.kind === 'extends') return `extended-by:${sourceName}`;
      if (edge.kind === 'implements') return `implemented-by:${sourceName}`;
      if (edge.kind === 'type_of') return `type-used-by:${sourceName}`;
      if (edge.kind === 'contains') return `contained-in:${sourceName}`;
      return `${edge.kind}:${sourceName}`;
    }

    if (edge.kind === 'calls') return `calls:${targetName}`;
    if (edge.kind === 'imports') return `imports:${targetName}`;
    if (edge.kind === 'extends') return `extends:${targetName}`;
    if (edge.kind === 'implements') return `implements:${targetName}`;
    if (edge.kind === 'type_of') return `type_of:${targetName}`;
    if (edge.kind === 'contains') return `contains:${targetName}`;
    return `${edge.kind}:${targetName}`;
  }

  private traceFallbackNodes(from: Node, to: Node): Node[] {
    const siblings = this.queries.getNodesByFile(to.filePath)
      .filter((node) => node.id !== to.id && node.kind !== 'file' && !node.isExternal)
      .sort(compareNodes)
      .slice(0, 5);
    return uniqueNodes([from, to, ...siblings]);
  }

  private nodesForEdges(edges: Edge[]): Node[] {
    return uniqueNodes(edges.flatMap((edge) => {
      const source = this.queries.getNode(edge.source);
      const target = edge.target === null ? undefined : this.queries.getNode(edge.target);
      return [source, target].filter((node): node is Node => node !== undefined);
    }));
  }

  private ambiguityLookupNotes(lookup: SymbolLookupResult, label = 'symbol'): string[] {
    return lookup.candidates.length > 1
      ? [`${label} is ambiguous; selected ${lookup.best?.qualifiedName ?? 'no candidate'} from ${lookup.candidates.length} candidates`]
      : [];
  }

  private meta(options: Parameters<typeof buildMeta>[1] = {}): ToolMeta {
    return buildMeta(this.queries, options);
  }

  private isFullyResolved(): boolean {
    const coverage = this.queries.getCoverage();
    return coverage.total === coverage.resolved;
  }
}

const CONTEXT_EDGE_KINDS: EdgeKind[] = ['contains', 'calls', 'imports', 'extends', 'implements', 'type_of'];

interface ContextCandidate {
  node: Node;
  distance: number;
  reason: string;
}

interface ScoredContextCandidate extends ContextCandidate {
  score: number;
}

function normalizedFtsScores(results: SearchOutput): Map<string, number> {
  const rawScores = results.map((result) => result.score);
  const maxScore = Math.max(0, ...rawScores);
  const scores = new Map<string, number>();
  for (const result of results) {
    scores.set(result.node.id, maxScore > 0 ? result.score / maxScore : 1);
  }
  return scores;
}

function normalizedDegreeScores(queries: QueryBuilder, nodes: Node[]): Map<string, number> {
  const kinds = new Set<EdgeKind>(CONTEXT_EDGE_KINDS);
  const rawDegrees = new Map<string, number>();
  for (const node of nodes) {
    const outgoing = queries.getEdgesBySource(node.id).filter((edge) => kinds.has(edge.kind)).length;
    const incoming = queries.getEdgesByTarget(node.id).filter((edge) => kinds.has(edge.kind)).length;
    rawDegrees.set(node.id, outgoing + incoming);
  }

  const maxDegree = Math.max(0, ...rawDegrees.values());
  const degrees = new Map<string, number>();
  for (const [id, degree] of rawDegrees) {
    degrees.set(id, maxDegree > 0 ? degree / maxDegree : 0);
  }
  return degrees;
}

function contextScore(
  candidate: ContextCandidate,
  components: { fts: number; centrality: number },
): number {
  const proximity = 1 / (candidate.distance + 1);
  return (1.0 * components.fts)
    + (0.4 * components.centrality)
    + (0.3 * (candidate.node.isExported ? 1 : 0))
    - (0.5 * (candidate.node.isGenerated ? 1 : 0))
    - (0.3 * (candidate.node.isTest ? 1 : 0))
    + (0.5 * proximity);
}

function compareContextCandidates(a: ScoredContextCandidate, b: ScoredContextCandidate): number {
  return b.score - a.score
    || compareStrings(a.node.filePath, b.node.filePath)
    || a.node.range.startLine - b.node.range.startLine
    || compareStrings(a.node.qualifiedName, b.node.qualifiedName);
}

function edgeNotes(edges: Edge[]): string[] {
  const included = new Set(edges.map((edge) => edge.id ?? `${edge.source}:${edge.kind}:${edge.target ?? edge.targetName ?? ''}`));
  const ambiguous = edges.filter((edge) => edge.resolutionState === 'ambiguous').length;
  const unresolved = edges.filter((edge) => edge.resolutionState === 'unresolved').length;
  const external = edges.filter((edge) => edge.resolutionState === 'external').length;
  const weak = edges.filter((edge) => edge.confidence !== 'high').length;
  const notes: string[] = [];
  if (ambiguous > 0) notes.push(`${ambiguous} ambiguous edge(s) included`);
  if (unresolved > 0) notes.push(`${unresolved} unresolved edge(s) included`);
  if (external > 0) notes.push(`${external} external edge(s) included`);
  if (weak > 0) notes.push(`${weak} non-high-confidence edge(s) included`);
  if (included.size !== edges.length) notes.push('Duplicate edge rows collapsed in output');
  return notes;
}

function ambiguityNotes(edges: Edge[], names: string[]): string[] {
  const notes = edgeNotes(edges);
  const duplicates = names.length - new Set(names).size;
  return duplicates > 0 ? [...notes, `${duplicates} duplicate symbol name(s) in result candidates`] : notes;
}

function filesForNodes(nodes: Node[]): string[] {
  return [...new Set(nodes.filter((node) => !node.isExternal).map((node) => node.filePath))].sort(compareStrings);
}

function groupNodesByFile(nodes: Node[], maxFiles: number): Map<string, Node[]> {
  const result = new Map<string, Node[]>();
  for (const node of nodes.sort(compareNodes)) {
    if (node.isExternal) continue;
    if (!result.has(node.filePath)) {
      if (result.size >= maxFiles) continue;
      result.set(node.filePath, []);
    }
    result.get(node.filePath)?.push(node);
  }
  for (const [filePath, fileNodes] of result) {
    result.set(filePath, uniqueNodes(fileNodes).sort(compareNodes));
  }
  return result;
}

function uniqueNodes(nodes: Node[]): Node[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function uniqueNodeRefs(nodes: NodeRef[]): NodeRef[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function matchesPattern(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${escaped}$`).test(filePath);
}

function pathDepth(filePath: string): number {
  return filePath.split('/').filter((part) => part !== '').length;
}

function sortCallerOutputs(outputs: CallersOutput): CallersOutput {
  return [...outputs].sort((a, b) => compareNodeRefs(a.caller, b.caller) || compareEdgeRefs(a.callSite, b.callSite));
}

function sortCalleeOutputs(outputs: CalleesOutput): CalleesOutput {
  return [...outputs].sort((a, b) => compareNodeRefs(a.callee, b.callee) || compareEdgeRefs(a.callSite, b.callSite));
}

function sortNodeRefs(nodes: NodeRef[]): NodeRef[] {
  return [...nodes].sort(compareNodeRefs);
}

function sortEdgeRefs(edges: EdgeRef[]): EdgeRef[] {
  return [...edges].sort(compareEdgeRefs);
}

function compareImpactOutputs(a: ImpactOutput[number], b: ImpactOutput[number]): number {
  return a.distance - b.distance || compareNodeRefs(a.node, b.node);
}

function compareExploreFiles(
  a: ExploreOutput['files'][number],
  b: ExploreOutput['files'][number],
): number {
  return compareStrings(a.filePath, b.filePath);
}

function compareFileEntries(a: FileEntry, b: FileEntry): number {
  return compareStrings(a.filePath, b.filePath);
}

function compareNodes(a: Node, b: Node): number {
  return compareStrings(a.filePath, b.filePath)
    || a.range.startLine - b.range.startLine
    || compareStrings(a.qualifiedName, b.qualifiedName);
}

function compareNodeRefs(a: NodeRef, b: NodeRef): number {
  return compareStrings(a.filePath, b.filePath)
    || a.range.startLine - b.range.startLine
    || compareStrings(a.qualifiedName, b.qualifiedName);
}

function compareEdgeRefs(a: EdgeRef, b: EdgeRef): number {
  return compareStrings(a.kind, b.kind)
    || compareStrings(a.source, b.source)
    || compareStrings(a.target ?? '', b.target ?? '')
    || (a.line ?? -1) - (b.line ?? -1)
    || (a.col ?? -1) - (b.col ?? -1);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
