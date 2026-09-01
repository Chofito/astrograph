/**
 * Why a path could not be proven (AG-209).
 *
 * `traverseGraph` skips an edge whose target is null *before* it records a
 * visit, because it exists to enumerate reachable nodes and a null target has
 * no node. That makes it structurally incapable of explaining a negative
 * `trace`: the unresolved hop that blocked the path is exactly the edge it
 * discarded.
 *
 * This walks the same frontier but collects every candidate edge at each
 * inspected node *before* deciding whether it can advance through it. It is a
 * separate primitive on purpose — changing `traverseGraph` would change
 * `impact`, `context` and `explore` too.
 */

import type { Edge, EdgeKind, Node } from "../types";

/** The narrow read port this walk needs; storage integrity is not assumed. */
interface PathEvidenceQueries {
	getNode(id: string): Node | undefined;
	getEdgesBySource(id: string): Edge[];
}

export interface PathEvidenceInput {
	startId: string;
	edgeKinds: EdgeKind[];
	maxDepth: number;
	/** Hard cap on inspected nodes, so a hostile graph cannot run away. */
	limit: number;
}

export interface PathEvidenceResult {
	/** Every candidate edge out of an inspected node, unproven ones included. */
	edges: Edge[];
	/** Nodes whose outgoing edges were actually read. */
	inspected: number;
	/**
	 * True when the node cap leaves valid queued nodes, or `maxDepth` leaves a
	 * requested-kind edge to an existing, unvisited, non-null target. Unresolved,
	 * missing, and cyclic edges alone are exhausted work, not truncation.
	 */
	truncated: boolean;
}

/**
 * Collect the relations reachable from `startId` within `maxDepth`.
 *
 * Edges are gathered from nodes at distance `< maxDepth`, matching the frontier
 * `findPath` would have expanded. A blocker sitting one hop past that boundary
 * was never inspected and is deliberately absent rather than reported as
 * examined-and-fine.
 */
export function collectPathEvidence(
	queries: PathEvidenceQueries,
	input: PathEvidenceInput,
): PathEvidenceResult {
	const start = queries.getNode(input.startId);
	if (start === undefined) {
		return { edges: [], inspected: 0, truncated: false };
	}

	const kinds = new Set(input.edgeKinds);
	const seen = new Set<string>([start.id]);
	const queue: { id: string; distance: number }[] = [
		{ id: start.id, distance: 0 },
	];
	const edges: Edge[] = [];
	let inspected = 0;
	let truncated = false;

	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;

		if (inspected >= input.limit) {
			truncated = true;
			break;
		}

		if (current.distance >= input.maxDepth) {
			// Past the frontier. A relation alone is not a remaining search
			// candidate: unresolved targets, missing rows, and already-seen nodes
			// cannot advance the walk. Only a valid, unvisited target means the
			// depth limit actually cut useful search work short.
			const hasTraversableCandidate = queries
				.getEdgesBySource(current.id)
				.some(
					(edge) =>
						kinds.has(edge.kind) &&
						edge.target !== null &&
						!seen.has(edge.target) &&
						queries.getNode(edge.target) !== undefined,
				);
			if (hasTraversableCandidate) truncated = true;
			continue;
		}

		inspected += 1;
		const outgoing = queries
			.getEdgesBySource(current.id)
			.filter((edge) => kinds.has(edge.kind));

		for (const edge of outgoing) {
			// Collected first. An edge we cannot follow is the answer, not noise.
			edges.push(edge);

			if (edge.target === null || seen.has(edge.target)) continue;
			if (queries.getNode(edge.target) === undefined) continue;
			seen.add(edge.target);
			queue.push({ id: edge.target, distance: current.distance + 1 });
		}
	}

	return { edges, inspected, truncated };
}
