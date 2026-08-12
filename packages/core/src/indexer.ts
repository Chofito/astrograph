import type { QueryBuilder } from "./db/queries";
import { type ReconcileStats, reconcileNodes } from "./extraction/reconcile";
import type { LanguageRegistry } from "./extraction/registry";
import { languageFromPath } from "./extraction/shared/language";
import type {
	AstrographConfig,
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

export class Indexer {
	readonly queries: QueryBuilder;

	private readonly storage: StorageAdapter;
	private readonly fs: FileSystem;
	private readonly hasher: Hasher;
	private readonly glob: GlobScanner;
	private readonly registry: LanguageRegistry;
	private readonly config: AstrographConfig;
	private readonly root: string;
	private readonly now: () => number;

	/**
	 * One `resolveEdges` result per file per pass. Each call re-runs a full TS
	 * parse, and both Pass B phases need the same answer.
	 */
	private readonly resolveCache = new Map<string, EdgeResolutionResult>();
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
		this.config = options.config ?? {};
		this.root = normalizePath(options.root);
		this.now = options.now ?? Date.now;
	}

	/** Pass A vs Pass B set arithmetic totals from the last index/sync. */
	reconcileStats(): ReconcileStats {
		return { ...this.lastReconcileStats };
	}

	async indexAll(options: IndexAllOptions = {}): Promise<void> {
		const configHash = await this.computeConfigHash();
		const files = await this.scanFiles();

		options.onProgress?.({
			phase: "scan",
			current: files.length,
			total: files.length,
		});

		this.beginPass(files);

		for (let i = 0; i < files.length; i++) {
			const relPath = files[i]!;
			options.onProgress?.({
				phase: "parse",
				current: i + 1,
				total: files.length,
				file: relPath,
			});
			await this.indexFilePassA(relPath, { force: options.force ?? false });
		}

		// Pass B is two-phase: reconcile all nodes first (FK-safe targets), then
		// edges. Files whose backend has no enricher are already final.
		for (let i = 0; i < files.length; i++) {
			const relPath = files[i]!;
			options.onProgress?.({
				phase: "resolve",
				current: i + 1,
				total: files.length,
				file: relPath,
			});
			this.indexFileReconcile(relPath);
		}
		for (const relPath of files) {
			this.indexFileResolveEdges(relPath);
		}

		this.persistProjectMetadata(configHash);
		options.onProgress?.({
			phase: "done",
			current: files.length,
			total: files.length,
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

		const scanned = await this.scanFiles();
		const scannedSet = new Set(scanned);
		const knownFiles = this.queries.getAllFiles();
		const knownByPath = new Map(knownFiles.map((file) => [file.path, file]));

		const added: string[] = [];
		const modified: string[] = [];
		const removed: string[] = [];
		const maxFileSizeBytes = this.config.maxFileSizeBytes ?? 2_000_000;

		for (const relPath of scanned) {
			const stat = await this.fs.stat(this.joinRoot(relPath));
			const contentHash =
				stat.size > maxFileSizeBytes
					? ""
					: this.hasher.hash(await this.fs.readText(this.joinRoot(relPath)));
			const known = knownByPath.get(relPath);

			if (known === undefined) {
				added.push(relPath);
			} else if (configChanged || known.contentHash !== contentHash) {
				modified.push(relPath);
			}
		}

		for (const file of knownFiles) {
			if (!scannedSet.has(file.path)) removed.push(file.path);
		}

		const changedFiles = [...added, ...modified];

		const referrerFiles = this.findReferrerFilesForTargets(changedFiles);

		for (const relPath of removed) {
			const priorNodeIds = this.queries
				.getNodesByFile(relPath)
				.map((n) => n.id);
			const incomingEdges = this.findIncomingEdges(priorNodeIds);
			this.queries.deleteByFile(relPath);
			this.markIncomingEdgesUnresolved(incomingEdges);
		}

		if (changedFiles.length > 0) {
			this.beginPass(scanned);

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
		const maxFileSizeBytes = this.config.maxFileSizeBytes ?? 2_000_000;

		for (const relPath of changedCandidates) {
			const absolutePath = this.joinRoot(relPath);
			if (!(await this.fs.exists(absolutePath))) {
				removed.push(relPath);
				continue;
			}

			const stat = await this.fs.stat(absolutePath);
			const contentHash =
				stat.size > maxFileSizeBytes
					? ""
					: this.hasher.hash(await this.fs.readText(absolutePath));
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

		for (const relPath of removedFiles) {
			const priorNodeIds = this.queries
				.getNodesByFile(relPath)
				.map((n) => n.id);
			const incomingEdges = this.findIncomingEdges(priorNodeIds);
			this.queries.deleteByFile(relPath);
			this.markIncomingEdgesUnresolved(incomingEdges);
		}

		if (changedFiles.length > 0 || removedFiles.length > 0) {
			const projectFiles = this.queries
				.getAllFiles()
				.map((file) => file.path)
				.filter((path) => !removedFiles.includes(path));
			for (const relPath of added) {
				if (!projectFiles.includes(relPath)) projectFiles.push(relPath);
			}
			projectFiles.sort(compareStrings);

			this.beginPass(projectFiles);

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
	private beginPass(files: string[]): void {
		this.resolveCache.clear();
		this.lastReconcileStats = { matched: 0, added: 0, dropped: 0 };

		const byBackend = new Map<string, string[]>();
		for (const relPath of files) {
			const backend = this.registry.backendForPath(relPath);
			if (!backend) continue;
			const bucket = byBackend.get(backend.id);
			if (bucket) bucket.push(relPath);
			else byBackend.set(backend.id, [relPath]);
		}

		for (const backend of this.registry.list()) {
			const loadProject = backend.enricher?.loadProject;
			if (!loadProject) continue;
			loadProject.call(backend.enricher, {
				rootPath: this.root,
				tsconfigPath: this.config.tsconfigPath,
				fileNames: byBackend.get(backend.id) ?? [],
				loadNodesForFile: (filePath) => this.queries.getNodesByFile(filePath),
			});
		}
	}

	/** `resolveEdges` is expensive (a full re-parse); memoize it per pass. */
	private resolveFor(
		relPath: string,
		backend: LanguageBackend,
	): EdgeResolutionResult | undefined {
		const enricher = backend.enricher;
		if (!enricher || enricher.mode === "none") return undefined;
		const cached = this.resolveCache.get(relPath);
		if (cached) return cached;
		const result = enricher.resolveEdges(relPath);
		this.resolveCache.set(relPath, result);
		return result;
	}

	private async indexFilePassA(
		relPath: string,
		options: { force: boolean },
	): Promise<void> {
		const absolutePath = this.joinRoot(relPath);
		const stat = await this.fs.stat(absolutePath);
		const maxFileSizeBytes = this.config.maxFileSizeBytes ?? 2_000_000;
		const backend = this.registry.backendForPath(relPath);

		if (stat.size > maxFileSizeBytes) {
			this.writeParsedFile(relPath, {
				contentHash: "",
				size: stat.size,
				modifiedAt: stat.modifiedAt,
				nodes: [],
				edges: [],
				errors: [
					{
						message: `File exceeds maxFileSizeBytes (${maxFileSizeBytes})`,
						filePath: relPath,
						severity: "warning",
						code: "FILE_TOO_LARGE",
					},
				],
			});
			return;
		}

		if (!backend) {
			this.writeParsedFile(relPath, {
				contentHash: "",
				size: stat.size,
				modifiedAt: stat.modifiedAt,
				nodes: [],
				edges: [],
				errors: [
					{
						message: `No language backend claims ${relPath}`,
						filePath: relPath,
						severity: "warning",
						code: "NO_BACKEND",
					},
				],
			});
			return;
		}

		const source = await this.fs.readText(absolutePath);
		const contentHash = this.hasher.hash(source);
		const existing = this.queries.getFile(relPath);
		if (!options.force && existing?.contentHash === contentHash) return;

		// A "replace" enricher owns the node set outright; running Pass A would
		// only produce rows it is about to delete.
		const skipPassA = backend.enricher?.mode === "replace";
		const extraction = skipPassA
			? { nodes: [], edges: [], errors: [] }
			: backend.parser.extractNodes(relPath, source);

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
		const backend = this.registry.backendForPath(relPath);
		if (!backend) return;
		const result = this.resolveFor(relPath, backend);
		if (!result?.nodes) return;
		const enriched = result.nodes;

		const write = this.storage.transaction(() => {
			const passANodes = this.queries.getNodesByFile(relPath);
			const plan = reconcileNodes(passANodes, enriched, {
				provenance: "ts-compiler",
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
					errors: mergeErrors(file.errors, plan.errors),
				});
			}
		});
		write();
	}

	/** Pass B phase 2: write edges after all reconciled nodes exist. */
	private indexFileResolveEdges(relPath: string): void {
		const backend = this.registry.backendForPath(relPath);
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
			".astrograph/config.json",
		];

		// Ask every registered backend for its real versions, so bumping a grammar
		// or the compiler actually invalidates the index.
		const parts = Object.entries(this.registry.versionKeys()).map(
			([key, value]) => `${key}:${value}`,
		);
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

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/\/$/, "");
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Keep a file's Pass A errors and append reconciliation warnings, de-duped. */
function mergeErrors(
	existing: ExtractionError[] | undefined,
	added: ExtractionError[],
): ExtractionError[] | undefined {
	const kept = (existing ?? []).filter(
		(error) => error.code !== "PASS_A_NODE_DROPPED",
	);
	const merged = [...kept, ...added];
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
