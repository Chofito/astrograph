import {
	type AstrographConfig,
	type NormalizedAstrographConfig,
	normalizeAstrographConfig,
	semanticAstrographConfig,
} from "./config";
import type { QueryBuilder } from "./db/queries";
import { type ReconcileStats, reconcileNodes } from "./extraction/reconcile";
import {
	type LanguageRegistry,
	shippedBackendExtensionOwners,
} from "./extraction/registry";
import {
	buildMembership,
	eligibilityEvidence,
	type IndexEligibility,
	materialize,
	type Membership,
} from "./eligibility";
import { languageFromPath } from "./extraction/shared/language";
import type {
	Edge,
	EdgeResolutionResult,
	ExtractionError,
	FileRecord,
	FileSystem,
	GlobScanner,
	Hasher,
	IndexProgress,
	LanguageBackend,
	Node,
	StorageAdapter,
	WatchEvent,
} from "./types";

export interface IndexerOptions {
	queries: QueryBuilder;
	storage: StorageAdapter;
	fs: FileSystem;
	hasher: Hasher;
	glob: GlobScanner;
	registry: LanguageRegistry;
	config?: AstrographConfig;
	root: string;
	now?: () => number;
}

export interface IndexAllOptions {
	force?: boolean;
	onProgress?: (e: IndexProgress) => void;
}

/**
 * Coordinates full indexing and incremental convergence for one project.
 *
 * Language routing belongs to the registry; this class owns persistence order,
 * reconciliation, invalidation, and storage lifetime.
 */
export class Indexer {
	readonly queries: QueryBuilder;

	private readonly storage: StorageAdapter;
	private readonly fs: FileSystem;
	private readonly hasher: Hasher;
	private readonly glob: GlobScanner;
	private readonly registry: LanguageRegistry;
	private readonly config: NormalizedAstrographConfig;
	private readonly root: string;
	private readonly now: () => number;

	/**
	 * One `resolveEdges` result per file per pass. Each call re-runs a full TS
	 * parse, and both Pass B phases need the same answer.
	 */
	private readonly resolveCache = new Map<string, EdgeResolutionResult>();
	/**
	 * Membership for the pass in flight. Computed once and read by Pass A,
	 * `loadProject`, both Pass B phases, and retirement, so no consumer can
	 * disagree about which files belong to the graph (AG-202).
	 */
	private membership: Membership = emptyMembership();
	/** Reconciliation counters for the most recent pass, for diagnostics/tests. */
	private lastReconcileStats: ReconcileStats = {
		matched: 0,
		added: 0,
		dropped: 0,
	};

	constructor(options: IndexerOptions) {
		this.queries = options.queries;
		this.storage = options.storage;
		this.fs = options.fs;
		this.hasher = options.hasher;
		this.glob = options.glob;
		this.registry = options.registry;
		this.config = normalizeAstrographConfig(options.config, {
			knownBackendIds: [
				...this.registry.list().map((backend) => backend.id),
				...Object.keys(options.config?.backends ?? {}),
			],
		});
		this.root = normalizePath(options.root);
		this.now = options.now ?? Date.now;
	}

	/** Pass A vs Pass B set arithmetic totals from the last index/sync. */
	reconcileStats(): ReconcileStats {
		return { ...this.lastReconcileStats };
	}

	async indexAll(options: IndexAllOptions = {}): Promise<void> {
		const configHash = await this.computeConfigHash();
		const membership = await this.classifyProject();
		const eligible = membership.eligible.map((entry) => entry.path);

		options.onProgress?.({
			phase: "scan",
			current: eligible.length,
			total: eligible.length,
		});

		// A crashed pass leaves a half-written graph. Marking the index
		// in-progress *before* any mutation means the next run can see it, and
		// `configHash` is only written once the work below actually finished.
		const previousPassInterrupted = this.lastPassInterrupted();
		this.markPassInProgress();

		this.beginPass(membership);

		// Convergence: a full index over a reused database must retire whatever
		// no longer belongs, before Pass A, using the same policy sync uses.
		// Without this a deleted, newly-excluded, now-oversized or
		// disabled-backend file kept answering queries forever.
		this.retireLostMembership(membership);

		// A file the graph cannot read still deserves a record saying why, but it
		// must never reach a parser or an enricher.
		for (const entry of membership.recordable) {
			await this.recordIneligibleFile(entry);
		}

		// An interrupted predecessor may have left files that look current but are
		// not, so their content hash cannot be trusted to skip work.
		const force = options.force === true || previousPassInterrupted;

		for (let i = 0; i < eligible.length; i++) {
			const relPath = eligible[i]!;
			options.onProgress?.({
				phase: "parse",
				current: i + 1,
				total: eligible.length,
				file: relPath,
			});
			await this.indexFilePassA(relPath, { force });
		}

		// Pass B is two-phase: reconcile all nodes first (FK-safe targets), then
		// edges. Files whose backend has no enricher are already final.
		for (let i = 0; i < eligible.length; i++) {
			const relPath = eligible[i]!;
			options.onProgress?.({
				phase: "resolve",
				current: i + 1,
				total: eligible.length,
				file: relPath,
			});
			this.indexFileReconcile(relPath);
		}
		for (const relPath of eligible) {
			this.indexFileResolveEdges(relPath);
		}

		// Only now is the identity allowed to advance: everything above completed.
		this.persistProjectMetadata(configHash);
		options.onProgress?.({
			phase: "done",
			current: eligible.length,
			total: eligible.length,
		});
	}

	/**
	 * The single classification every phase reads. Scanning owns
	 * include/exclude/gitignore; this adds backend ownership, enablement, and the
	 * size limit, and folds in already-persisted paths so a file that left the
	 * project is visible as `out_of_scope`.
	 */
	private async classifyProject(): Promise<Membership> {
		const scanned = await this.scanFiles();
		return buildMembership({
			registry: this.registry,
			config: this.config,
			shippedExtensionOwners: shippedBackendExtensionOwners(),
			scanned,
			known: this.queries.getAllFiles().map((file) => file.path),
			sizeOf: async (relPath) => {
				try {
					return (await this.fs.stat(this.joinRoot(relPath))).size;
				} catch {
					return undefined;
				}
			},
		});
	}

	/**
	 * Retire every persisted file the current membership no longer accepts.
	 *
	 * Covers deletion, a newly excluded path, a file that grew past the limit, an
	 * extension whose backend was disabled, and a semantic configuration change
	 * that narrowed the project. `recordable` entries are retired too: their old
	 * nodes must go even though a record explaining the absence stays behind.
	 */
	private retireLostMembership(membership: Membership): void {
		for (const file of this.queries.getAllFiles()) {
			if (membership.isEligible(file.path)) continue;
			this.retireFile(file.path);
		}
	}

	/** True when the previous pass began but never recorded completion. */
	lastPassInterrupted(): boolean {
		return this.getProjectMetadata("passState") === "in_progress";
	}

	private markPassInProgress(): void {
		const now = this.now();
		const write = this.storage.transaction(() => {
			this.upsertProjectMetadata("passState", "in_progress", now);
		});
		write();
	}

	/** Persist why a claimed-but-unusable file is absent from the graph. */
	private async recordIneligibleFile(entry: IndexEligibility): Promise<void> {
		const evidence = eligibilityEvidence(entry);
		if (evidence === null) return;
		this.writeParsedFile(entry.path, {
			contentHash: "",
			size: entry.size ?? 0,
			modifiedAt: this.now(),
			nodes: [],
			edges: [],
			errors: [
				{
					message: evidence.message,
					filePath: entry.path,
					severity: "warning",
					code: evidence.code,
				},
			],
		});
	}

	/** Extensions every registered backend claims. See `AstrographCore`. */
	indexableExtensions(): string[] {
		return this.registry.allExtensions();
	}

	async sync(): Promise<{
		added: string[];
		modified: string[];
		removed: string[];
	}> {
		const configHash = await this.computeConfigHash();
		const storedConfigHash = this.getProjectMetadata("configHash");
		const configChanged =
			storedConfigHash !== undefined && storedConfigHash !== configHash;

		// Same classification the full index uses. A file that stopped being
		// eligible — excluded, oversized, or owned by a backend the user just
		// disabled — is a removal, not a silent survivor.
		const membership = await this.classifyProject();
		this.markPassInProgress();
		const knownFiles = this.queries.getAllFiles();
		const knownByPath = new Map(knownFiles.map((file) => [file.path, file]));

		const added: string[] = [];
		const modified: string[] = [];
		const removed: string[] = [];

		for (const entry of membership.eligible) {
			const relPath = entry.path;
			const contentHash = this.hasher.hash(
				await this.fs.readText(this.joinRoot(relPath)),
			);
			const known = knownByPath.get(relPath);

			if (known === undefined) {
				added.push(relPath);
			} else if (configChanged || known.contentHash !== contentHash) {
				modified.push(relPath);
			}
		}

		for (const file of knownFiles) {
			if (!membership.isEligible(file.path)) removed.push(file.path);
		}

		const changedFiles = [...added, ...modified];

		const referrerFiles = this.findReferrerFilesForTargets(changedFiles);

		for (const relPath of removed) this.retireFile(relPath);

		if (changedFiles.length > 0) {
			this.beginPass(membership);

			for (const relPath of changedFiles) {
				await this.indexFilePassA(relPath, { force: true });
			}

			const resolveSet = [...new Set([...changedFiles, ...referrerFiles])];
			for (const relPath of resolveSet) {
				this.indexFileReconcile(relPath);
			}
			for (const relPath of resolveSet) {
				this.indexFileResolveEdges(relPath);
			}

			this.healUnresolvedEdges(changedFiles);
		}

		for (const entry of membership.recordable) {
			await this.recordIneligibleFile(entry);
		}

		this.persistProjectMetadata(configHash);

		return {
			added: added.sort(compareStrings),
			modified: modified.sort(compareStrings),
			removed: removed.sort(compareStrings),
		};
	}

	async syncFiles(
		events: WatchEvent[],
	): Promise<{ added: string[]; modified: string[]; removed: string[] }> {
		const normalizedEvents = mergeEvents(events);
		const removed = normalizedEvents
			.filter((event) => event.type === "unlink")
			.map((event) => event.path);
		const changedCandidates = normalizedEvents
			.filter((event) => event.type !== "unlink")
			.map((event) => event.path);

		const added: string[] = [];
		const modified: string[] = [];
		const changedFiles: string[] = [];

		// One classification for the whole event batch, identical to the one full
		// index and scanner sync use.
		const membership = await this.classifyProject();

		for (const relPath of changedCandidates) {
			const absolutePath = this.joinRoot(relPath);
			if (!(await this.fs.exists(absolutePath))) {
				removed.push(relPath);
				continue;
			}

			// An event for a path the project does not own is not a change. Without
			// this an oversized or excluded file re-entered Pass A on every save.
			if (!membership.isEligible(relPath)) {
				if (this.queries.getFile(relPath) !== undefined) removed.push(relPath);
				continue;
			}

			const contentHash = this.hasher.hash(
				await this.fs.readText(absolutePath),
			);
			const known = this.queries.getFile(relPath);

			if (known === undefined) {
				added.push(relPath);
				changedFiles.push(relPath);
			} else if (known.contentHash !== contentHash) {
				modified.push(relPath);
				changedFiles.push(relPath);
			}
		}

		const removedFiles = uniqueStrings(removed);
		const referrerFiles = this.findReferrerFilesForTargets(changedFiles);

		for (const relPath of removedFiles) this.retireFile(relPath);

		if (changedFiles.length > 0 || removedFiles.length > 0) {
			this.beginPass(membership);

			for (const relPath of changedFiles) {
				await this.indexFilePassA(relPath, { force: true });
			}

			const resolveSet = [...new Set([...changedFiles, ...referrerFiles])];
			for (const relPath of resolveSet) {
				this.indexFileReconcile(relPath);
			}
			for (const relPath of resolveSet) {
				this.indexFileResolveEdges(relPath);
			}

			this.healUnresolvedEdges(changedFiles);
		}

		return {
			added: added.sort(compareStrings),
			modified: modified.sort(compareStrings),
			removed: removedFiles,
		};
	}

	close(): void {
		this.storage.close();
	}

	/**
	 * Start a fresh pass: drop the per-file resolve cache, reset counters, and
	 * give every enricher the slice of the project its own backend owns. The TS
	 * program no longer sees `.php` paths in its rootNames.
	 */
	private beginPass(membership: Membership): void {
		this.resolveCache.clear();
		this.lastReconcileStats = { matched: 0, added: 0, dropped: 0 };
		this.membership = membership;

		// `byBackend` already holds only eligible files, so an oversized file or a
		// file owned by a disabled backend can never enter a backend's project.
		for (const backend of this.registry.list()) {
			const loadProject = backend.enricher?.loadProject;
			if (!loadProject) continue;
			loadProject.call(backend.enricher, {
				rootPath: this.root,
				tsconfigPath: this.config.tsconfigPath,
				fileNames: [...(membership.byBackend.get(backend.id) ?? [])],
				loadNodesForFile: (filePath) => this.queries.getNodesByFile(filePath),
			});
		}
	}

	/**
	 * The owning backend, but only for a file this pass classified as eligible.
	 * Every Pass B entry point goes through here, so an ineligible path cannot
	 * reach `resolveEdges` or reconciliation even if a caller passes it in.
	 */
	private eligibleBackendFor(relPath: string): LanguageBackend | undefined {
		const entry = this.membership.get(relPath);
		if (entry?.eligible !== true || entry.backendId === undefined) {
			return undefined;
		}
		return this.registry.backendById(entry.backendId);
	}

	/** `resolveEdges` is expensive (a full re-parse); memoize it per pass. */
	private resolveFor(
		relPath: string,
		backend: LanguageBackend,
	): EdgeResolutionResult | undefined {
		const enricher = backend.enricher;
		// No enricher means Pass-A-only: there is nothing to resolve.
		if (!enricher) return undefined;
		const cached = this.resolveCache.get(relPath);
		if (cached) return cached;
		const result = enricher.resolveEdges(relPath);
		this.resolveCache.set(relPath, result);
		return result;
	}

	/**
	 * Pass A for one file the membership snapshot already declared eligible.
	 *
	 * The size limit and backend ownership are not re-checked here: doing so was
	 * the second definition of eligibility, and it let an oversized file be
	 * excluded from Pass A while still sitting in a backend's `loadProject` set.
	 */
	private async indexFilePassA(
		relPath: string,
		options: { force: boolean },
	): Promise<void> {
		const entry = this.membership.get(relPath);
		if (entry?.eligible !== true) return;
		const backend =
			entry.backendId === undefined
				? undefined
				: this.registry.backendById(entry.backendId);
		if (backend === undefined) return;

		const absolutePath = this.joinRoot(relPath);
		const stat = await this.fs.stat(absolutePath);
		const source = await this.fs.readText(absolutePath);
		const contentHash = this.hasher.hash(source);
		const existing = this.queries.getFile(relPath);
		if (!options.force && existing?.contentHash === contentHash) return;

		// Pass A is the structural floor: every eligible claimed file runs it
		// exactly once, whether or not the backend also ships an enricher.
		const extraction = backend.parser.extractNodes(relPath, source);

		this.writeParsedFile(relPath, {
			contentHash,
			size: stat.size,
			modifiedAt: stat.modifiedAt,
			nodes: extraction.nodes,
			edges: extraction.edges,
			errors: extraction.errors,
			// Without an enricher, Pass A is the final answer for this file.
			state: backend.enricher === undefined ? "resolved" : "parsed",
		});
	}

	/**
	 * Pass B phase 1: reconcile the enricher's node view onto Pass A by node id
	 * instead of deleting every Pass A row. Matched ids keep their row (and
	 * every cross-file edge pointing at them) and are updated in place.
	 */
	private indexFileReconcile(relPath: string): void {
		const backend = this.eligibleBackendFor(relPath);
		if (!backend) return;
		const enricher = backend.enricher;
		if (!enricher) return;
		const result = this.resolveFor(relPath, backend);
		if (!result?.nodes) return;
		const enriched = result.nodes;

		const write = this.storage.transaction(() => {
			const passANodes = this.queries.getNodesByFile(relPath);
			// Provenance is declared by the producing enricher; the indexer must
			// never infer it from a language name.
			const plan = reconcileNodes(passANodes, enriched, {
				provenance: enricher.provenance,
				filePath: relPath,
			});

			// Pass A's `contains` edges reference Pass A ids; Pass B rewrites the
			// file's edges wholesale in phase 2, so clear them before touching nodes.
			for (const node of passANodes) {
				for (const edge of this.queries.getEdgesBySource(node.id)) {
					if (edge.id !== undefined) this.queries.deleteEdge(edge.id);
				}
			}
			for (const nodeId of plan.delete) this.queries.deleteNode(nodeId);
			for (const node of plan.update) this.queries.upsertNode(node);
			for (const node of plan.insert) this.queries.upsertNode(node);
			for (const node of result.externalNodes) {
				if (isPersistableExternalNode(node, this.root)) {
					this.queries.upsertNode(node);
				}
			}

			this.lastReconcileStats = {
				matched: this.lastReconcileStats.matched + plan.stats.matched,
				added: this.lastReconcileStats.added + plan.stats.added,
				dropped: this.lastReconcileStats.dropped + plan.stats.dropped,
			};

			const file = this.queries.getFile(relPath);
			if (file) {
				const kept = this.queries
					.getNodesByFile(relPath)
					.filter((node) => !node.isExternal);
				this.queries.upsertFile({
					...file,
					nodeCount: kept.length,
					state: "parsed",
					// Reconciliation recomputes the dropped-node set from scratch.
					errors: mergeErrors(file.errors, plan.errors, {
						replaces: ["PASS_A_NODE_DROPPED"],
					}),
				});
			}
		});
		write();
	}

	/** Pass B phase 2: write edges after all reconciled nodes exist. */
	private indexFileResolveEdges(relPath: string): void {
		const backend = this.eligibleBackendFor(relPath);
		if (!backend) return;
		const result = this.resolveFor(relPath, backend);
		// No enricher: Pass A already wrote the file's nodes, edges and state.
		if (!result) return;

		const write = this.storage.transaction(() => {
			const fileNodes = this.queries.getNodesByFile(relPath);
			for (const node of fileNodes) {
				const nodeEdges = this.queries.getEdgesBySource(node.id);
				for (const edge of nodeEdges) {
					if (edge.id !== undefined) this.queries.deleteEdge(edge.id);
				}
			}

			for (const node of result.externalNodes) {
				if (isPersistableExternalNode(node, this.root)) {
					this.queries.upsertNode(node);
				}
			}

			for (const edge of result.edges) {
				this.queries.upsertEdge(edge);
			}

			const file = this.queries.getFile(relPath);
			if (file) {
				this.queries.upsertFile({
					...file,
					state: "resolved",
					errors: mergeErrors(file.errors, result.errors),
				});
			}
		});

		write();

		// Phase 2 is the last reader of this file's result. Dropping it here keeps
		// the memoization from holding every file's nodes+edges until the pass ends.
		this.resolveCache.delete(relPath);
	}

	/**
	 * Remove a file from the graph and keep the rest of it honest.
	 *
	 * One policy, shared by the full index and both sync paths: capture the
	 * edges pointing at this file's nodes *before* deleting them, then mark those
	 * edges unresolved. Deleting first would either dangle them or silently drop
	 * a relationship that still exists in the source.
	 */
	private retireFile(relPath: string): void {
		const priorNodeIds = this.queries.getNodesByFile(relPath).map((n) => n.id);
		const incomingEdges = this.findIncomingEdges(priorNodeIds);
		this.queries.deleteByFile(relPath);
		this.markIncomingEdgesUnresolved(incomingEdges);
	}

	private healUnresolvedEdges(changedFiles: string[]): void {
		const newNodes = new Map<string, string>();
		for (const relPath of changedFiles) {
			for (const node of this.queries.getNodesByFile(relPath)) {
				newNodes.set(node.name, node.id);
			}
		}

		for (const [name, nodeId] of newNodes) {
			const unresolvedEdges =
				this.queries.getEdgesByResolutionStateAndTargetName("unresolved", name);
			for (const edge of unresolvedEdges) {
				if (edge.id !== undefined) {
					this.queries.upsertEdge({
						...edge,
						target: nodeId,
						resolutionState: "resolved",
						confidence: "medium",
					});
				}
			}
		}
	}

	private findReferrerFilesForTargets(changedFiles: string[]): string[] {
		const changedNodeIds = new Set<string>();
		for (const relPath of changedFiles) {
			for (const node of this.queries.getNodesByFile(relPath)) {
				changedNodeIds.add(node.id);
			}
		}

		const referrerFiles = new Set<string>();
		for (const nodeId of changedNodeIds) {
			const incomingEdges = this.queries.getEdgesByTarget(nodeId);
			for (const edge of incomingEdges) {
				const sourceNode = this.queries.getNode(edge.source);
				if (sourceNode) {
					referrerFiles.add(sourceNode.filePath);
				}
			}
		}

		return [...referrerFiles].filter((f) => !changedFiles.includes(f));
	}

	private findIncomingEdges(
		targetNodeIds: string[],
	): ReturnType<QueryBuilder["getAllEdges"]> {
		return targetNodeIds.flatMap((nodeId) =>
			this.queries.getEdgesByTarget(nodeId),
		);
	}

	private markIncomingEdgesUnresolved(
		incomingEdges: ReturnType<QueryBuilder["getAllEdges"]>,
	): void {
		for (const edge of incomingEdges) {
			if (this.queries.getNode(edge.source) === undefined) continue;
			const { id: _id, ...edgeWithoutId } = edge;
			this.queries.upsertEdge({
				...edgeWithoutId,
				target: null,
				resolutionState: "unresolved",
				confidence: "low",
				targetName: edge.targetName ?? edge.target ?? undefined,
			});
		}
	}

	private writeParsedFile(
		relPath: string,
		input: {
			contentHash: string;
			size: number;
			modifiedAt: number;
			nodes: Node[];
			edges: Edge[];
			errors: ExtractionError[];
			state?: FileRecord["state"];
		},
	): void {
		const write = this.storage.transaction(() => {
			this.queries.deleteByFile(relPath);
			for (const node of input.nodes) {
				this.queries.upsertNode(node);
			}
			// Pass A edges reference Pass A ids only, so they are always insertable
			// here and make the `parsed` state structurally useful on its own.
			for (const edge of input.edges) {
				this.queries.upsertEdge(edge);
			}

			const file: FileRecord = {
				path: relPath,
				project: "root",
				contentHash: input.contentHash,
				language: languageFromPath(relPath) ?? "unknown",
				size: input.size,
				modifiedAt: input.modifiedAt,
				indexedAt: this.now(),
				nodeCount: input.nodes.length,
				state: input.state ?? "parsed",
				errors: input.errors.length > 0 ? input.errors : undefined,
			};
			this.queries.upsertFile(file);
		});

		write();
	}

	private async scanFiles(): Promise<string[]> {
		const files: string[] = [];
		for await (const relPath of this.glob.scan(this.root, {
			include: this.config.include,
			exclude: this.config.exclude,
			gitignore: true,
		})) {
			files.push(normalizePath(relPath));
		}
		files.sort(compareStrings);
		return files;
	}

	private async computeConfigHash(): Promise<string> {
		const inputs = [
			this.config.tsconfigPath ?? "tsconfig.json",
			"jsconfig.json",
			"package.json",
			"bun.lock",
			"bun.lockb",
			"package-lock.json",
			"yarn.lock",
			"pnpm-lock.yaml",
			".gitignore",
		];

		// Ask every registered backend for its real versions, so bumping a grammar
		// or the compiler actually invalidates the index.
		const parts = [
			`config:${JSON.stringify(semanticAstrographConfig(this.config))}`,
			...Object.entries(this.registry.versionKeys()).map(
				([key, value]) => `${key}:${value}`,
			),
		];
		for (const relPath of inputs) {
			const absolutePath = this.joinRoot(relPath);
			if (!(await this.fs.exists(absolutePath))) continue;
			parts.push(`${relPath}\u001f${await this.fs.readText(absolutePath)}`);
		}

		return this.hasher.hash(parts.sort(compareStrings).join("\u001e"));
	}

	private persistProjectMetadata(configHash: string): void {
		const now = this.now();
		const write = this.storage.transaction(() => {
			this.upsertProjectMetadata("rootPath", this.root, now);
			this.upsertProjectMetadata("lastIndexedAt", String(now), now);
			for (const [key, value] of Object.entries(this.registry.versionKeys())) {
				this.upsertProjectMetadata(`version:${key}`, value, now);
			}
			this.upsertProjectMetadata("configHash", configHash, now);
			// Written last and in the same transaction as the identity: an index is
			// only "complete" when its configHash and versions describe work that
			// actually finished.
			this.upsertProjectMetadata("passState", "complete", now);
		});
		write();
	}

	private getProjectMetadata(key: string): string | undefined {
		const row = this.storage
			.prepare("SELECT value FROM project_metadata WHERE key = ?")
			.get(key) as { value: string } | null | undefined;
		return row?.value;
	}

	private upsertProjectMetadata(
		key: string,
		value: string,
		updatedAt: number,
	): void {
		this.storage
			.prepare(
				`INSERT INTO project_metadata (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value=excluded.value,
         updated_at=excluded.updated_at`,
			)
			.run(key, value, updatedAt);
	}

	private joinRoot(relPath: string): string {
		return `${this.root}/${relPath}`.replaceAll("//", "/");
	}
}

function emptyMembership(): Membership {
	return materialize([]);
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/\/$/, "");
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Merge a phase's evidence into a file record.
 *
 * `replaces` names the codes the incoming batch fully recomputes, so a re-run
 * refreshes them instead of stacking duplicates. Codes outside that list are
 * preserved: Pass B phase 2 must not erase the `PASS_A_NODE_DROPPED` warnings
 * phase 1 produced, because they are the only persisted evidence that a backend
 * broke the subset contract.
 */
function mergeErrors(
	existing: ExtractionError[] | undefined,
	added: ExtractionError[],
	options: { replaces?: readonly string[] } = {},
): ExtractionError[] | undefined {
	const replaces = new Set(options.replaces ?? []);
	const kept = (existing ?? []).filter(
		(error) => error.code === undefined || !replaces.has(error.code),
	);

	// Both Pass B phases can run again for the same file within one pass (a
	// changed file is also a referrer), so identical evidence must not stack.
	const merged: ExtractionError[] = [];
	const seen = new Set<string>();
	for (const error of [...kept, ...added]) {
		const key = [
			error.code ?? "",
			error.filePath ?? "",
			error.line ?? "",
			error.column ?? "",
			error.severity,
			error.message,
		].join("\u001f");
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(error);
	}

	return merged.length > 0 ? merged : undefined;
}

/**
 * External nodes must stay portable: no absolute paths that only make sense on
 * the machine where TypeScript's default libs were resolved at compile time.
 */
function isPersistableExternalNode(node: Node, root: string): boolean {
	const filePath = node.filePath.replaceAll("\\", "/");
	if (filePath.startsWith("/") || /^[A-Za-z]:\//.test(filePath)) {
		const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
		return (
			filePath === normalizedRoot || filePath.startsWith(`${normalizedRoot}/`)
		);
	}
	return true;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)].sort(compareStrings);
}

function mergeEvents(events: WatchEvent[]): WatchEvent[] {
	const byPath = new Map<string, WatchEvent>();
	for (const event of events) {
		const path = normalizePath(event.path);
		const prior = byPath.get(path);
		if (
			prior === undefined ||
			event.type === "unlink" ||
			prior.type === "unlink"
		) {
			byPath.set(path, { type: event.type, path });
		}
	}
	return [...byPath.values()].sort((a, b) => compareStrings(a.path, b.path));
}
