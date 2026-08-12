import type { ExtractionError, Node, Provenance } from "../types";

export interface ReconcileStats {
	/** Ids present in both Pass A and the enricher's node view. */
	matched: number;
	/** Enricher-only ids — the kinds Pass A conservatively skipped. */
	added: number;
	/** Pass-A-only ids. Non-zero means Pass A escaped its subset contract. */
	dropped: number;
}

export interface ReconcilePlan {
	/** Enricher records whose id already exists; overwrite the row in place. */
	update: Node[];
	/** Enricher records with no Pass A counterpart; insert. */
	insert: Node[];
	/**
	 * Always empty. Pass A nodes the enricher did not produce are **kept**
	 * (tree-sitter is the base). `stats.dropped` + `PASS_A_NODE_DROPPED`
	 * warnings still fire so identity bugs are visible.
	 */
	delete: string[];
	/** One warning per dropped id, so a subset violation is visible not silent. */
	errors: ExtractionError[];
	stats: ReconcileStats;
}

export interface ReconcileOptions {
	/** Stamped into `metadata.provenance` on every enricher record. */
	provenance?: Provenance;
	/** Only used to label the emitted `PASS_A_NODE_DROPPED` warnings. */
	filePath?: string;
}

/**
 * Set arithmetic between Pass A's structural nodes and the enricher's
 * authoritative node view for one file, keyed by node id.
 *
 * Pass A is contractually a *subset* of the enricher's output: it only emits a
 * declaration when it can prove the enricher will compute the same
 * `hash(project · filePath · kind · qualifiedName · locator)`. So `dropped`
 * should be 0 for any language with an enricher; when it is not, each dropped
 * id becomes a `PASS_A_NODE_DROPPED` warning. The Pass A row is **kept** —
 * enrichers may insert, never delete.
 *
 * Pure and DB-free on purpose — the caller applies the plan in a transaction.
 */
export function reconcileNodes(
	passA: Node[],
	enriched: Node[],
	options: ReconcileOptions = {},
): ReconcilePlan {
	const passAById = new Map(passA.map((node) => [node.id, node]));
	const enrichedById = new Map(enriched.map((node) => [node.id, node]));

	const update: Node[] = [];
	const insert: Node[] = [];

	for (const node of enrichedById.values()) {
		const stamped =
			options.provenance === undefined
				? node
				: {
						...node,
						metadata: { ...node.metadata, provenance: options.provenance },
					};
		if (passAById.has(node.id)) update.push(stamped);
		else insert.push(stamped);
	}

	const errors: ExtractionError[] = [];
	let dropped = 0;
	for (const node of passAById.values()) {
		if (enrichedById.has(node.id)) continue;
		dropped += 1;
		errors.push({
			message: `Pass A emitted ${node.kind} ${node.qualifiedName} but the enricher did not; keeping the Pass A node. Pass A must stay a subset of the enricher's node set.`,
			filePath: options.filePath ?? node.filePath,
			line: node.range.startLine,
			severity: "warning",
			code: "PASS_A_NODE_DROPPED",
		});
	}

	return {
		update,
		insert,
		delete: [],
		errors,
		stats: {
			matched: update.length,
			added: insert.length,
			dropped,
		},
	};
}
