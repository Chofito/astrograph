import { expect } from "bun:test";
import type { Edge, Node } from "../types";
import {
	type GraphLike,
	type NormalizedGraph,
	type NormalizeOptions,
	normalize,
} from "./normalize";

export function nodeIdSet(nodes: Iterable<Node>): Set<string> {
	return new Set([...nodes].map((node) => node.id));
}

/** Every resolved edge must point at an existing node id. */
export function assertNoDanglingResolved(
	edges: Edge[],
	nodes: Iterable<Node>,
): void {
	const ids = nodeIdSet(nodes);
	const dangling = edges.filter(
		(edge) =>
			edge.resolutionState === "resolved" &&
			edge.target !== null &&
			!ids.has(edge.target),
	);
	expect(dangling).toEqual([]);
}

/** Resolver dedup key — must stay stable across refactors. */
export function edgeDedupKey(edge: Edge): string {
	return `${edge.source}\u0000${edge.kind}\u0000${edge.target ?? ""}\u0000${edge.line ?? -1}`;
}

export function assertUniqueEdgeKeys(edges: Edge[]): void {
	const keys = edges.map(edgeDedupKey);
	expect(new Set(keys).size).toBe(keys.length);
}

export function assertGraphIntegrity(graph: GraphLike): void {
	assertNoDanglingResolved(graph.edges, graph.nodes);
	assertUniqueEdgeKeys(graph.edges);
}

export function assertNormalizedGraphEqual(
	actual: GraphLike,
	expected: NormalizedGraph,
	options?: NormalizeOptions,
): void {
	expect(normalize(actual, options)).toEqual(expected);
}

export function assertDeterministicNormalized(
	run: () => NormalizedGraph,
): void {
	const first = run();
	const second = run();
	expect(second).toEqual(first);
}

export async function assertDeterministicNormalizedAsync(
	run: () => NormalizedGraph | Promise<NormalizedGraph>,
): Promise<void> {
	const first = await run();
	const second = await run();
	expect(second).toEqual(first);
}

export async function assertDeterministicExtract(
	run: () => GraphLike,
	options?: NormalizeOptions,
): Promise<void> {
	assertDeterministicNormalized(() => normalize(run(), options));
}
