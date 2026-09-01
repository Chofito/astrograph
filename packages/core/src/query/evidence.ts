/**
 * Relational evidence: the edges an answer could not follow (AG-207).
 *
 * Node-shaped results filter `edge.target === null` because there is no node to
 * show. That is a payload decision, and it silently deleted the most important
 * fact in the answer: an empty `callees` looked identical whether the symbol
 * calls nothing or calls three things nobody could resolve. Evidence is
 * collected *before* that filter and travels in metadata.
 *
 * Bounded on purpose. Counts are exact; samples are capped and deterministically
 * ordered, and truncation is stated rather than hidden.
 */

import type {
	Edge,
	EdgeKind,
	Provenance,
	ResolutionState,
} from "../types";

/** Default sample cap. Enough to act on, small enough to stay a projection. */
export const MAX_EVIDENCE_SAMPLES = 10;

/** One unproven relation, with no source text and nothing sensitive. */
export interface UnprovenRelation {
	/** Node id of the origin. Ids are already public in every payload. */
	source: string;
	kind: EdgeKind;
	resolutionState: Exclude<ResolutionState, "resolved">;
	/** The textual target the extractor saw, when it knew one. */
	targetName?: string;
	line?: number;
	col?: number;
	provenance: Provenance;
	/** Backend-supplied explanation, when the producer recorded one. */
	reason?: string;
}

export interface RelationEvidence {
	/** Exact totals by state and kind, sorted. Never truncated. */
	counts: { resolutionState: ResolutionState; kind: EdgeKind; count: number }[];
	/** Bounded, sorted sample of the individual unproven relations. */
	samples: UnprovenRelation[];
	/** True when `samples` omits relations that `counts` includes. */
	truncated: boolean;
}

/**
 * Summarize the edges an answer considered.
 *
 * `external` is kept as its own state and never folded into failure: a call
 * into `node_modules` is a complete answer about a target outside the project,
 * not a gap. Callers decide whether external matters for their question.
 */
export function collectEvidence(
	edges: readonly Edge[],
	options: { limit?: number } = {},
): RelationEvidence | undefined {
	const limit = options.limit ?? MAX_EVIDENCE_SAMPLES;

	const tally = new Map<string, number>();
	const unproven: UnprovenRelation[] = [];

	for (const edge of edges) {
		const key = `${edge.resolutionState}${edge.kind}`;
		tally.set(key, (tally.get(key) ?? 0) + 1);

		if (edge.resolutionState === "resolved") continue;
		unproven.push({
			source: edge.source,
			kind: edge.kind,
			resolutionState: edge.resolutionState,
			provenance: edge.provenance,
			...(edge.targetName === undefined ? {} : { targetName: edge.targetName }),
			...(edge.line === undefined ? {} : { line: edge.line }),
			...(edge.col === undefined ? {} : { col: edge.col }),
			...reasonOf(edge),
		});
	}

	if (tally.size === 0) return undefined;

	const counts = [...tally.entries()]
		.map(([key, count]) => {
			const [resolutionState, kind] = key.split("");
			return {
				resolutionState: resolutionState as ResolutionState,
				kind: kind as EdgeKind,
				count,
			};
		})
		.sort(
			(a, b) =>
				a.resolutionState.localeCompare(b.resolutionState) ||
				a.kind.localeCompare(b.kind),
		);

	unproven.sort(compareRelations);

	return {
		counts,
		samples: unproven.slice(0, limit),
		truncated: unproven.length > limit,
	};
}

/** Human-facing lines mirroring the evidence, for `ToolMeta.notes`. */
export function evidenceNotes(
	evidence: RelationEvidence | undefined,
): string[] {
	if (evidence === undefined) return [];

	const notes: string[] = [];
	for (const entry of evidence.counts) {
		if (entry.resolutionState === "resolved") continue;
		notes.push(
			`${entry.count} ${entry.resolutionState} ${entry.kind} relation(s) could not be shown as nodes.`,
		);
	}
	if (evidence.truncated) {
		notes.push(
			`Only the first ${evidence.samples.length} unproven relations are listed; the counts above are exact.`,
		);
	}
	return notes;
}

/** Whether the evidence contains anything that can change a negative answer. */
export function hasUnprovenRelations(
	evidence: RelationEvidence | undefined,
): boolean {
	if (evidence === undefined) return false;
	// `external` is a complete answer about a target outside the project.
	return evidence.counts.some(
		(entry) =>
			entry.resolutionState === "unresolved" ||
			entry.resolutionState === "ambiguous",
	);
}

function reasonOf(edge: Edge): { reason?: string } {
	const raw = edge.metadata?.reason;
	return typeof raw === "string" && raw.length > 0 ? { reason: raw } : {};
}

function compareRelations(a: UnprovenRelation, b: UnprovenRelation): number {
	return (
		a.resolutionState.localeCompare(b.resolutionState) ||
		a.kind.localeCompare(b.kind) ||
		(a.targetName ?? "").localeCompare(b.targetName ?? "") ||
		a.source.localeCompare(b.source) ||
		(a.line ?? -1) - (b.line ?? -1) ||
		(a.col ?? -1) - (b.col ?? -1)
	);
}
