import type { Edge, Node } from "../types";

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

function compareNodes(a: NormalizedNode, b: NormalizedNode): number {
	return (
		compareStrings(a.filePath, b.filePath) ||
		a.range.startLine - b.range.startLine ||
		compareStrings(a.kind, b.kind) ||
		compareStrings(a.qualifiedName, b.qualifiedName)
	);
}

function compareEdges(a: NormalizedEdge, b: NormalizedEdge): number {
	return (
		compareStrings(a.source, b.source) ||
		compareStrings(a.kind, b.kind) ||
		compareStrings(a.target ?? "", b.target ?? "") ||
		(a.line ?? -1) - (b.line ?? -1)
	);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function normalizePath(path: string, rootPath?: string): string {
	let normalizedPath = path.replaceAll("\\", "/");

	const nodeModulesIdx = normalizedPath.indexOf("/node_modules/");
	if (nodeModulesIdx >= 0) {
		normalizedPath = normalizedPath.slice(nodeModulesIdx + 1);
	}

	if (rootPath === undefined) return normalizedPath;

	const normalizedRoot = rootPath.replaceAll("\\", "/").replace(/\/$/, "");
	if (normalizedPath === normalizedRoot) return "";
	if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
		return normalizedPath.slice(normalizedRoot.length + 1);
	}
	return normalizedPath;
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
