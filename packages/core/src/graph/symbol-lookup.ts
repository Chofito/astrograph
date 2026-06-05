import type { Node } from "../types";
import { QueryBuilder } from "../db/queries";

export interface SymbolLookupResult {
	best?: Node;
	candidates: Node[];
}

export function resolveSymbol(
	queries: QueryBuilder,
	symbol: string,
): SymbolLookupResult {
	const byId = queries.getNode(symbol);
	if (byId !== undefined) return { best: byId, candidates: [byId] };

	const exact = queries.findNodesByName(symbol, 50);
	if (exact.length > 0) {
		const candidates = sortCandidates(exact);
		return { best: candidates[0], candidates };
	}

	const ftsMatches = queries
		.search({ query: symbol, limit: 50, includeGenerated: true })
		.map((match) => queries.getNode(match.node.id))
		.filter((node): node is Node => node !== undefined);
	const candidates = sortCandidates(ftsMatches);
	return { best: candidates[0], candidates };
}

function sortCandidates(nodes: Node[]): Node[] {
	const seen = new Set<string>();
	return nodes
		.filter((node) => {
			if (seen.has(node.id)) return false;
			seen.add(node.id);
			return true;
		})
		.sort(compareNodes);
}

function compareNodes(a: Node, b: Node): number {
	return (
		Number(a.isGenerated) - Number(b.isGenerated) ||
		Number(a.isTest) - Number(b.isTest) ||
		Number(b.isExported) - Number(a.isExported) ||
		Number(a.isExternal) - Number(b.isExternal) ||
		compareStrings(a.filePath, b.filePath) ||
		a.range.startLine - b.range.startLine ||
		compareStrings(a.qualifiedName, b.qualifiedName)
	);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
