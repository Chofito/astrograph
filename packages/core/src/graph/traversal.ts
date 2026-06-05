import type { Edge, EdgeKind, Node } from "../types";
import { QueryBuilder } from "../db/queries";

export interface TraverseInput {
	startId: string;
	direction: "outgoing" | "incoming";
	edgeKinds?: EdgeKind[];
	maxDepth: number;
	limit: number;
}

export interface TraversalVisit {
	node: Node;
	distance: number;
	path: Edge[];
}

export function traverseGraph(
	queries: QueryBuilder,
	input: TraverseInput,
): TraversalVisit[] {
	const start = queries.getNode(input.startId);
	if (start === undefined) return [];

	const edgeKinds =
		input.edgeKinds === undefined ? undefined : new Set(input.edgeKinds);
	const seen = new Set<string>([start.id]);
	const visits: TraversalVisit[] = [{ node: start, distance: 0, path: [] }];
	const queue: TraversalVisit[] = visits.slice();

	while (queue.length > 0 && visits.length < input.limit) {
		const current = queue.shift();
		if (current === undefined || current.distance >= input.maxDepth) continue;

		const edges =
			input.direction === "outgoing"
				? queries.getEdgesBySource(current.node.id)
				: queries.getEdgesByTarget(current.node.id);

		for (const edge of sortEdges(edges).filter(
			(e) => edgeKinds === undefined || edgeKinds.has(e.kind),
		)) {
			const nextId = input.direction === "outgoing" ? edge.target : edge.source;
			if (nextId === null || seen.has(nextId)) continue;

			const nextNode = queries.getNode(nextId);
			if (nextNode === undefined) continue;

			seen.add(nextId);
			const visit: TraversalVisit = {
				node: nextNode,
				distance: current.distance + 1,
				path: [...current.path, edge],
			};
			visits.push(visit);
			queue.push(visit);
			if (visits.length >= input.limit) break;
		}
	}

	return visits.sort(compareVisits);
}

export function findPath(
	queries: QueryBuilder,
	input: Omit<TraverseInput, "limit"> & { targetId: string; limit?: number },
): Edge[] | undefined {
	const start = queries.getNode(input.startId);
	if (start === undefined) return undefined;

	const edgeKinds =
		input.edgeKinds === undefined ? undefined : new Set(input.edgeKinds);
	const seen = new Set<string>([start.id]);
	const queue: { nodeId: string; distance: number; path: Edge[] }[] = [
		{ nodeId: start.id, distance: 0, path: [] },
	];
	let visited = 0;
	const limit = input.limit ?? 500;

	while (queue.length > 0 && visited < limit) {
		const current = queue.shift();
		if (current === undefined) continue;
		visited += 1;
		if (current.nodeId === input.targetId) return current.path;
		if (current.distance >= input.maxDepth) continue;

		const edges =
			input.direction === "outgoing"
				? queries.getEdgesBySource(current.nodeId)
				: queries.getEdgesByTarget(current.nodeId);

		for (const edge of sortEdges(edges).filter(
			(e) => edgeKinds === undefined || edgeKinds.has(e.kind),
		)) {
			const nextId = input.direction === "outgoing" ? edge.target : edge.source;
			if (nextId === null || seen.has(nextId)) continue;
			if (queries.getNode(nextId) === undefined) continue;
			seen.add(nextId);
			queue.push({
				nodeId: nextId,
				distance: current.distance + 1,
				path: [...current.path, edge],
			});
		}
		queue.sort(compareQueueEntries);
	}

	return undefined;
}

function sortEdges(edges: Edge[]): Edge[] {
	return [...edges].sort(compareEdges);
}

function compareVisits(a: TraversalVisit, b: TraversalVisit): number {
	return (
		a.distance - b.distance ||
		compareStrings(a.node.filePath, b.node.filePath) ||
		a.node.range.startLine - b.node.range.startLine ||
		compareStrings(a.node.qualifiedName, b.node.qualifiedName)
	);
}

function compareQueueEntries(
	a: { nodeId: string; distance: number; path: Edge[] },
	b: { nodeId: string; distance: number; path: Edge[] },
): number {
	const aEdge = a.path.at(-1);
	const bEdge = b.path.at(-1);
	return (
		a.distance - b.distance ||
		compareStrings(aEdge?.source ?? "", bEdge?.source ?? "") ||
		compareStrings(aEdge?.target ?? "", bEdge?.target ?? "") ||
		compareStrings(a.nodeId, b.nodeId)
	);
}

function compareEdges(a: Edge, b: Edge): number {
	return (
		compareStrings(a.kind, b.kind) ||
		compareStrings(a.source, b.source) ||
		compareStrings(a.target ?? "", b.target ?? "") ||
		(a.line ?? -1) - (b.line ?? -1) ||
		(a.col ?? -1) - (b.col ?? -1) ||
		(a.id ?? -1) - (b.id ?? -1)
	);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
