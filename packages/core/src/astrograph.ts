import type { QueryBuilder } from "./db/queries";
import type { ReconcileStats } from "./extraction/reconcile";
import type { Indexer } from "./indexer";
import type { GraphQueries } from "./query/graph-queries";
import type {
	AstrographCore,
	CalleesInput,
	CalleesOutput,
	CallersInput,
	CallersOutput,
	ContextInput,
	ContextOutput,
	ExploreInput,
	ExploreOutput,
	FilesInput,
	FilesOutput,
	ImpactInput,
	ImpactOutput,
	IndexProgress,
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
} from "./types";

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

	indexAll(opts?: {
		force?: boolean;
		onProgress?: (e: IndexProgress) => void;
	}): Promise<void> {
		return this.indexer.indexAll(opts);
	}

	indexableExtensions(): string[] {
		return this.indexer.indexableExtensions();
	}

	/**
	 * Pass A vs Pass B set arithmetic from the last index/sync.
	 *
	 * Deliberately off `AstrographCore`: it is a diagnostic seam, not part of the
	 * tool surface. `dropped > 0` means tree-sitter emitted a node the enricher
	 * did not — i.e. Pass A broke its subset contract and ids churned.
	 */
	reconcileStats(): ReconcileStats {
		return this.indexer.reconcileStats();
	}

	sync(): Promise<{ added: string[]; modified: string[]; removed: string[] }> {
		return this.indexer.sync();
	}

	syncFiles(
		events: WatchEvent[],
	): Promise<{ added: string[]; modified: string[]; removed: string[] }> {
		return this.indexer.syncFiles(events);
	}

	close(): void {
		this.indexer.close();
	}
}
