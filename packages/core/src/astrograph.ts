import type {
  AstrographCore,
  CallersInput,
  CallersOutput,
  CalleesInput,
  CalleesOutput,
  ContextInput,
  ContextOutput,
  ExploreInput,
  ExploreOutput,
  FilesInput,
  FilesOutput,
  ImpactInput,
  ImpactOutput,
  NodeInput,
  NodeOutput,
  SearchInput,
  SearchOutput,
  StatusInput,
  StatusOutput,
  ToolResult,
  TraceInput,
  TraceOutput,
  WatchEvent,
} from './types';
import type { QueryBuilder } from './db/queries';
import type { Indexer } from './indexer';
import { GraphQueries } from './query/graph-queries';

export interface AstrographOptions {
  indexer: Indexer;
  graphQueries: GraphQueries;
}

export class Astrograph implements AstrographCore {
  readonly queries: QueryBuilder;

  private readonly indexer: Indexer;
  private readonly graphQueries: GraphQueries;

  constructor(options: AstrographOptions) {
    this.indexer = options.indexer;
    this.graphQueries = options.graphQueries;
    this.queries = options.indexer.queries;
  }

  search(input: SearchInput): Promise<ToolResult<SearchOutput>> {
    return this.graphQueries.search(input);
  }

  context(input: ContextInput): Promise<ToolResult<ContextOutput>> {
    return this.graphQueries.context(input);
  }

  trace(input: TraceInput): Promise<ToolResult<TraceOutput>> {
    return this.graphQueries.trace(input);
  }

  callers(input: CallersInput): Promise<ToolResult<CallersOutput>> {
    return this.graphQueries.callers(input);
  }

  callees(input: CalleesInput): Promise<ToolResult<CalleesOutput>> {
    return this.graphQueries.callees(input);
  }

  impact(input: ImpactInput): Promise<ToolResult<ImpactOutput>> {
    return this.graphQueries.impact(input);
  }

  getNode(input: NodeInput): Promise<ToolResult<NodeOutput>> {
    return this.graphQueries.getNode(input);
  }

  explore(input: ExploreInput): Promise<ToolResult<ExploreOutput>> {
    return this.graphQueries.explore(input);
  }

  getFiles(input: FilesInput): Promise<ToolResult<FilesOutput>> {
    return this.graphQueries.getFiles(input);
  }

  getStats(input: StatusInput): Promise<ToolResult<StatusOutput>> {
    return this.graphQueries.getStats(input);
  }

  indexAll(opts?: { force?: boolean }): Promise<void> {
    return this.indexer.indexAll(opts);
  }

  sync(): Promise<{ added: string[]; modified: string[]; removed: string[] }> {
    return this.indexer.sync();
  }

  syncFiles(events: WatchEvent[]): Promise<{ added: string[]; modified: string[]; removed: string[] }> {
    return this.indexer.syncFiles(events);
  }

  close(): void {
    this.indexer.close();
  }
}
