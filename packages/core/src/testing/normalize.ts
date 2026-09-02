import type { CompletenessDomain, PartialReason } from "../query/domains";
import type { RelationEvidence } from "../query/evidence";
import type {
	Coverage,
	Edge,
	ExtractionError,
	FileRecord,
	Hasher,
	Node,
	ToolMeta,
} from "../types";

/* -------------------------------------------------------------------------- */
/* The oracle contract (AG-301)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Identity of the comparison boundary itself.
 *
 * Bump it when a field changes stability class or an ordering rule changes.
 * A golden recorded under one version cannot be compared against another, and
 * the version is what makes that detectable instead of silent.
 */
export const ORACLE_SCHEMA_VERSION = "1";

/**
 * Whether a field survives normalization, and if not, why.
 *
 * Every field of every persisted shape carries one of these. A field is only
 * `volatile` when it cannot differ between two runs *for a reason unrelated to
 * the graph* — wall-clock time, a filesystem mtime, a SQLite rowid. Dropping a
 * field to make two outputs agree is how an oracle stops being one.
 */
export type FieldStability = "retained" | { volatile: string };

/** Compile-enforced: adding a field to `Node` fails here until it is classified. */
export const NODE_FIELD_STABILITY: Record<keyof Node, FieldStability> = {
	id: "retained",
	project: "retained",
	kind: "retained",
	name: "retained",
	qualifiedName: "retained",
	filePath: "retained",
	language: "retained",
	range: "retained",
	signature: "retained",
	docstring: "retained",
	visibility: "retained",
	isExported: "retained",
	isAsync: "retained",
	isStatic: "retained",
	isAbstract: "retained",
	isExternal: "retained",
	isGenerated: "retained",
	isTest: "retained",
	decorators: "retained",
	typeParameters: "retained",
	metadata: "retained",
	updatedAt: {
		volatile:
			"Wall-clock stamp of when the row was written. Two runs over identical source differ here for no graph-related reason.",
	},
};

export const EDGE_FIELD_STABILITY: Record<keyof Edge, FieldStability> = {
	id: {
		volatile:
			"SQLite autoincrement rowid. It records insertion order in one database, not a fact about the relation.",
	},
	source: "retained",
	target: "retained",
	targetName: "retained",
	kind: "retained",
	resolutionState: "retained",
	confidence: "retained",
	provenance: "retained",
	line: "retained",
	col: "retained",
	metadata: "retained",
};

export const FILE_FIELD_STABILITY: Record<keyof FileRecord, FieldStability> = {
	path: "retained",
	project: "retained",
	contentHash: "retained",
	language: "retained",
	size: "retained",
	nodeCount: "retained",
	state: "retained",
	errors: "retained",
	modifiedAt: {
		volatile:
			"Filesystem mtime. A checkout or a copy changes it without changing the file.",
	},
	indexedAt: {
		volatile:
			"Wall-clock stamp of when indexing ran, not a property of the project.",
	},
};

export const EXTRACTION_ERROR_FIELD_STABILITY: Record<
	keyof ExtractionError,
	FieldStability
> = {
	code: "retained",
	message: "retained",
	filePath: "retained",
	line: "retained",
	column: "retained",
	severity: "retained",
};

/**
 * The envelope's own stability rules.
 *
 * `ToolMeta` is the second snapshot kind this oracle defines, so it needs the
 * same compile-time enforcement the persisted shapes get: without this table a
 * new field on `ToolMeta` would be silently absent from every recorded
 * envelope, which is precisely the hole the tables above exist to close.
 *
 * Everything is retained. An envelope is a set of claims a user can act on, and
 * there is nothing machine-volatile in it — no clock, no rowid, no absolute
 * path except inside `pendingFiles`, `reasons[].files` and free text, which
 * `normalizeEnvelope` rewrites relative to the project root rather than
 * dropping.
 */
export const TOOL_META_FIELD_STABILITY: Record<keyof ToolMeta, FieldStability> =
	{
		coverage: "retained",
		partial: "retained",
		domain: "retained",
		reasons: "retained",
		evidence: "retained",
		pendingFiles: "retained",
		notes: "retained",
	};

/** Every field the oracle removes, with the reason, for documentation and tests. */
export function volatileFields(): { field: string; reason: string }[] {
	const removed: { field: string; reason: string }[] = [];

	const collect = (
		shape: string,
		entries: [string, FieldStability][],
	): void => {
		for (const [field, rule] of entries) {
			if (rule === "retained") continue;
			removed.push({ field: `${shape}.${field}`, reason: rule.volatile });
		}
	};

	// Each table is enumerated directly: widening a `Record<keyof T, …>` to a
	// string-keyed record is the kind of assignability question that is not worth
	// carrying in the one module every golden depends on.
	collect("Node", Object.entries(NODE_FIELD_STABILITY));
	collect("Edge", Object.entries(EDGE_FIELD_STABILITY));
	collect("FileRecord", Object.entries(FILE_FIELD_STABILITY));
	collect("ExtractionError", Object.entries(EXTRACTION_ERROR_FIELD_STABILITY));
	collect("ToolMeta", Object.entries(TOOL_META_FIELD_STABILITY));

	return removed.sort((a, b) => compareStrings(a.field, b.field));
}

export interface GraphLike {
	nodes: Node[];
	edges: Edge[];
}

export interface NormalizedGraph {
	nodes: NormalizedNode[];
	edges: NormalizedEdge[];
}

export type NormalizedNode = Omit<Node, "updatedAt">;
export type NormalizedEdge = Omit<Edge, "id">;

export interface NormalizeOptions {
	rootPath?: string;
}

export function normalize(
	graph: GraphLike,
	options: NormalizeOptions = {},
): NormalizedGraph {
	return {
		nodes: graph.nodes
			.map((node) => dropVolatileNodeFields(node, options))
			.sort(compareNodes),
		edges: graph.edges.map(dropVolatileEdgeFields).sort(compareEdges),
	};
}

function dropVolatileNodeFields(
	node: Node,
	options: NormalizeOptions,
): NormalizedNode {
	const { updatedAt: _updatedAt, ...stable } = node;
	return omitUndefined({
		...stable,
		filePath: normalizePath(stable.filePath, options.rootPath),
		qualifiedName: normalizeQualifiedName(
			stable.qualifiedName,
			options.rootPath,
		),
	}) as NormalizedNode;
}

function dropVolatileEdgeFields(edge: Edge): NormalizedEdge {
	const { id: _id, ...stable } = edge;
	return omitUndefined(stable) as NormalizedEdge;
}

/**
 * A **total** order over nodes, ending at the id.
 *
 * A partial order leaves ties to `Array.prototype.sort`, which is stable — so
 * the tie is broken by whatever order SQLite returned rows in. Two indexes with
 * identical content but different insertion history would then normalize
 * differently, and the oracle would report a divergence that is not one.
 */
function compareNodes(a: NormalizedNode, b: NormalizedNode): number {
	return (
		// The original key sequence, unchanged. New keys are appended, never
		// interleaved: inserting one earlier would reorder pairs that the old
		// comparator already separated, which silently rewrites every golden.
		compareStrings(a.filePath, b.filePath) ||
		a.range.startLine - b.range.startLine ||
		compareStrings(a.kind, b.kind) ||
		compareStrings(a.qualifiedName, b.qualifiedName) ||
		// Appended tie-breakers.
		a.range.startColumn - b.range.startColumn ||
		a.range.endLine - b.range.endLine ||
		a.range.endColumn - b.range.endColumn ||
		compareStrings(a.name, b.name) ||
		compareStrings(a.id, b.id)
	);
}

/**
 * A **total** order over edges.
 *
 * It has to end somewhere unique, and unlike a node an edge has no retained id
 * to end at — the rowid is volatile. So the last key is the canonicalized
 * `metadata`, the only remaining retained field. Without it two edges agreeing
 * on every other key but differing in `metadata` — two `ambiguous` relations
 * with different `candidates` is the realistic case — were left tied, and a tie
 * is broken by SQLite row order. Two runs over the same project could then
 * order those edges differently and the oracle would report a divergence that
 * is not one.
 */
function compareEdges(a: NormalizedEdge, b: NormalizedEdge): number {
	return (
		// Original key sequence first, for the same reason as `compareNodes`.
		compareStrings(a.source, b.source) ||
		compareStrings(a.kind, b.kind) ||
		compareStrings(a.target ?? "", b.target ?? "") ||
		(a.line ?? -1) - (b.line ?? -1) ||
		// Appended tie-breakers.
		compareStrings(a.targetName ?? "", b.targetName ?? "") ||
		(a.col ?? -1) - (b.col ?? -1) ||
		compareStrings(a.resolutionState, b.resolutionState) ||
		compareStrings(a.confidence, b.confidence) ||
		compareStrings(a.provenance, b.provenance) ||
		// The final, unique key. `canonicalize` sorts object keys, so two equal
		// metadata blobs written in a different key order still compare equal.
		compareStrings(canonicalize(a.metadata), canonicalize(b.metadata))
	);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A path as the oracle compares it: relative to the project root when it lies
 * inside it, and otherwise reduced to something that does not name the machine.
 *
 * Order matters, and getting it wrong loses information. The root is removed
 * **first**: a path inside the project keeps every segment after the root,
 * `node_modules` included. Trimming at `/node_modules/` before that collapsed
 * `<root>/packages/a/node_modules/x` and `<root>/packages/b/node_modules/x`
 * onto one path — two distinct declarations, in a monorepo, comparing equal.
 *
 * The `node_modules` fallback survives only for a path that is *still* absolute
 * after root removal, i.e. one outside the project. There it is the lesser
 * evil: such a path names somebody's home directory, and the package-relative
 * tail is the only part that is the same on the next machine. Nothing in the
 * production pipeline persists those — `isPersistableExternalNode` rejects an
 * external node whose path escapes the root — so this branch serves the
 * extractor-level callers that pass no root at all.
 */
function normalizePath(path: string, rootPath?: string): string {
	const normalizedPath = path.replaceAll("\\", "/");

	const relative = relativeToRoot(normalizedPath, rootPath);
	if (relative !== undefined) return relative;

	const nodeModulesIdx = normalizedPath.indexOf("/node_modules/");
	return nodeModulesIdx >= 0
		? normalizedPath.slice(nodeModulesIdx + 1)
		: normalizedPath;
}

/** The path relative to `rootPath`, or `undefined` when it is not under it. */
function relativeToRoot(
	normalizedPath: string,
	rootPath: string | undefined,
): string | undefined {
	if (rootPath === undefined) return undefined;
	const normalizedRoot = normalizeRoot(rootPath);
	if (normalizedRoot.length === 0) return undefined;
	if (normalizedPath === normalizedRoot) return "";
	if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
		return normalizedPath.slice(normalizedRoot.length + 1);
	}
	return undefined;
}

function normalizeRoot(rootPath: string): string {
	return rootPath.replaceAll("\\", "/").replace(/\/$/, "");
}

function normalizeQualifiedName(
	qualifiedName: string,
	rootPath?: string,
): string {
	const sep = qualifiedName.indexOf("::");
	if (sep === -1) return normalizePath(qualifiedName, rootPath);
	const filePart = qualifiedName.slice(0, sep);
	const namePart = qualifiedName.slice(sep + 2);
	return `${normalizePath(filePart, rootPath)}::${namePart}`;
}

/**
 * Drop keys whose value is `undefined`, recursively.
 *
 * This includes `metadata`, which the stability tables mark fully `retained`,
 * and it was raised as destructive normalization: `{ candidate: undefined,
 * count: 1 }` and `{ count: 1 }` produce the same snapshot. They do, and it is
 * deliberate. `metadata` is persisted as JSON and `JSON.stringify` omits
 * `undefined` object values, so the database cannot hold that difference. An
 * oracle that preserved it would report a divergence between an in-memory graph
 * and the identical graph read back out of SQLite — a false failure on every
 * fixture. `canonicalValue`, which `digest` uses, skips them for the same
 * reason.
 *
 * The rule, so nobody has to re-derive it: this oracle compares *persisted*
 * meaning, and a distinction SQLite cannot store is not a distinction. A field
 * whose absence is genuinely meaningful must be `null`, which is preserved.
 */
function omitUndefined(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(omitUndefined);
	}

	if (value !== null && typeof value === "object") {
		const cleaned: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			if (child !== undefined) cleaned[key] = omitUndefined(child);
		}
		return cleaned;
	}

	return value;
}

/* -------------------------------------------------------------------------- */
/* Whole-index normalization (AG-203)                                         */
/* -------------------------------------------------------------------------- */

/**
 * A file record with only the facts a caller can depend on.
 *
 * Which fields survive is declared by {@link FILE_FIELD_STABILITY}, not by this
 * type: `indexedAt` and `modifiedAt` are wall-clock and filesystem stamps, not
 * facts about the project. Everything else is kept, including `contentHash`,
 * `state` and `errors`, because a converged index must agree about *why* a file
 * is incomplete, not merely that it exists.
 */
export type NormalizedFile = Omit<
	FileRecord,
	"indexedAt" | "modifiedAt" | "errors"
> & {
	/** Sorted, so two runs that discovered the same problems compare equal. */
	errors: NormalizedError[];
};

/**
 * An extraction error with every field retained.
 *
 * Nothing is dropped: the code is the contract, and the severity, location and
 * wording are all evidence about *why* a file is incomplete. Only the project
 * root is removed from `filePath` and from the message text, because that
 * prefix names the machine rather than the graph.
 */
export type NormalizedError = ExtractionError;

export interface NormalizedIndex extends NormalizedGraph {
	files: NormalizedFile[];
}

export interface IndexSource {
	getAllFiles(): FileRecord[];
	getAllNodes(): Node[];
	getAllEdges(): Edge[];
}

/**
 * **The** comparison boundary for every 0.1-C pipeline golden and convergence
 * claim (AG-301). There is deliberately no second normalizer: a golden and a
 * convergence assertion that disagree about what counts as equal prove nothing
 * about each other.
 *
 * `normalize(indexAll(emptyDb)) === normalize(indexAll(reusedDb))` is the whole
 * point, so this drops exactly the fields {@link volatileFields} lists and
 * nothing else. Dropping more would let a real divergence pass; that is why
 * IDs, resolution state, confidence, provenance, file state and diagnostics all
 * survive even though keeping them makes two runs harder to agree.
 *
 * Query envelopes are **not** part of this snapshot. See
 * {@link normalizeEnvelope}.
 */
export function normalizeIndex(
	source: IndexSource,
	options: NormalizeOptions = {},
): NormalizedIndex {
	const graph = normalize(
		{ nodes: source.getAllNodes(), edges: source.getAllEdges() },
		options,
	);

	return {
		...graph,
		files: source
			.getAllFiles()
			.map((file) => dropVolatileFileFields(file, options))
			.sort((a, b) => compareStrings(a.path, b.path)),
	};
}

function dropVolatileFileFields(
	file: FileRecord,
	options: NormalizeOptions,
): NormalizedFile {
	const {
		indexedAt: _indexedAt,
		modifiedAt: _modifiedAt,
		errors,
		...stable
	} = file;
	return omitUndefined({
		...stable,
		path: normalizePath(stable.path, options.rootPath),
		errors: [...(errors ?? [])]
			.map((error) => normalizeError(error, options))
			.sort(compareErrors),
	}) as NormalizedFile;
}

/**
 * Keep the whole diagnostic, minus the machine it ran on.
 *
 * A compiler error carries an absolute path, and its message often repeats it.
 * Those are the "temporary absolute paths" the oracle is allowed to remove —
 * the run happened in a different temp directory, not on a different graph.
 * Nothing else about the error is touched: the code, severity, location and
 * wording are all evidence about *why* a file is incomplete, and a converged
 * index has to agree about them.
 */
function normalizeError(
	error: ExtractionError,
	options: NormalizeOptions,
): NormalizedError {
	return omitUndefined({
		...error,
		filePath:
			error.filePath === undefined
				? undefined
				: normalizePath(error.filePath, options.rootPath),
		message: stripRoot(error.message, options.rootPath),
	}) as NormalizedError;
}

function compareErrors(a: ExtractionError, b: ExtractionError): number {
	return (
		compareStrings(a.code ?? "", b.code ?? "") ||
		compareStrings(a.filePath ?? "", b.filePath ?? "") ||
		(a.line ?? -1) - (b.line ?? -1) ||
		(a.column ?? -1) - (b.column ?? -1) ||
		compareStrings(a.severity, b.severity) ||
		compareStrings(a.message, b.message)
	);
}

/**
 * Remove the project root wherever it appears inside free text.
 *
 * Only the root prefix is removed, never a path-shaped substring in general: a
 * message that genuinely names `/usr/lib/foo.d.ts` still says so, because that
 * path is the same on the next run and dropping it would hide a real difference.
 */
function stripRoot(text: string, rootPath?: string): string {
	if (rootPath === undefined) return text;
	const normalizedRoot = normalizeRoot(rootPath);
	if (normalizedRoot.length === 0) return text;

	// Slashed form first, so `<root>/src/a.ts` becomes `src/a.ts` rather than
	// `/src/a.ts`. The bare form then catches a message that names the root
	// itself, which would otherwise keep a temp directory in the snapshot.
	//
	// The bare form must stop at a path boundary. An unanchored `replaceAll` is
	// a substring replace over free text, and it corrupts a path that merely
	// starts with the root's characters: with a root of `/tmp/ag`, the message
	// "error in /tmp/agent/file.ts" became "error in ent/file.ts" — identical to
	// a different diagnostic that really did say "ent/file.ts". Two unrelated
	// errors collapsed into one, which is the failure this oracle exists to
	// prevent. The lookahead keeps a replacement only where the next character
	// cannot continue a file name — punctuation and whitespace end a path, so
	// `<root>: reason` is still stripped while `<root>ent/file.ts` is left alone.
	const boundary = new RegExp(
		`${escapeRegExp(normalizedRoot)}(?![A-Za-z0-9_.-])`,
		"g",
	);
	return text
		.replaceAll("\\", "/")
		.replaceAll(`${normalizedRoot}/`, "")
		.replace(boundary, "");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* -------------------------------------------------------------------------- */
/* Query-envelope snapshots (AG-301)                                          */
/* -------------------------------------------------------------------------- */

/**
 * A query's trust envelope, normalized - and deliberately a **separate type**.
 *
 * `ToolMeta` is not persisted graph truth. It is an answer *about* the graph,
 * computed per query from a completeness domain, and it legitimately differs
 * between two questions asked of the same index. Folding it into
 * `NormalizedIndex` would make an envelope difference look like a graph
 * divergence, and would make a graph golden fail because a query's wording
 * changed.
 *
 * A pipeline fixture that wants both takes two snapshots and compares them
 * independently.
 */
export interface NormalizedEnvelope {
	coverage: Coverage;
	partial: boolean;
	domain?: CompletenessDomain;
	reasons?: PartialReason[];
	/** Already bounded and deterministically ordered by `collectEvidence`. */
	evidence?: RelationEvidence;
	pendingFiles?: string[];
	notes?: string[];
}

/**
 * Normalize a tool envelope for comparison.
 *
 * Nothing is dropped: every field of `ToolMeta` is a claim the user can act on.
 * Only project-root prefixes are removed from paths and free text, for the same
 * reason they are removed from extraction errors.
 */
export function normalizeEnvelope(
	meta: ToolMeta,
	options: NormalizeOptions = {},
): NormalizedEnvelope {
	const reasons = meta.reasons?.map((reason) => ({
		...reason,
		detail: stripRoot(reason.detail, options.rootPath),
		...(reason.files === undefined
			? {}
			: {
					files: reason.files
						.map((file) => normalizePath(file, options.rootPath))
						.sort(compareStrings),
				}),
	}));

	return omitUndefined({
		coverage: meta.coverage,
		partial: meta.partial,
		domain: meta.domain,
		reasons,
		evidence: meta.evidence,
		pendingFiles: meta.pendingFiles
			?.map((file) => normalizePath(file, options.rootPath))
			.sort(compareStrings),
		notes: meta.notes?.map((note) => stripRoot(note, options.rootPath)),
	}) as NormalizedEnvelope;
}

/* -------------------------------------------------------------------------- */
/* Digests for corpora that cannot be committed (AG-301, DEV-014)             */
/* -------------------------------------------------------------------------- */

/**
 * Canonical JSON: object keys sorted, arrays left in oracle order.
 *
 * Array order is already meaningful - the comparators above put it there - so
 * sorting arrays would erase the ordering guarantee the oracle provides. Only
 * key order, which `JSON.stringify` takes from insertion, is canonicalized.
 */
export function canonicalize(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child === undefined) continue;
			sorted[key] = canonicalValue(child);
		}
		return sorted;
	}
	return value;
}

/**
 * A single comparable value for a normalized snapshot.
 *
 * Real-repository certification cannot commit a golden, because the corpus is
 * proprietary. It compares digests of the clean, reused, delta and event runs
 * and publishes only those digests. This exists so that path uses the *same*
 * normalization as committed fixtures: a digest over a different serialization
 * would prove nothing about the oracle.
 *
 * The hasher is injected rather than imported so this stays runtime-agnostic,
 * like every other port in core.
 */
export function digest(value: unknown, hasher: Hasher): string {
	return hasher.hash(`${ORACLE_SCHEMA_VERSION}\u001f${canonicalize(value)}`);
}
