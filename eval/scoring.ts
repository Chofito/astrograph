import type { ContextOutput, NodeRef, SearchOutput } from "@astrograph/core";
import type { EvalCase, EvalResult } from "./types";

export const PASS_THRESHOLD = 0.5;

export function scoreSearch(
	evalCase: EvalCase,
	results: SearchOutput,
	latencyMs: number,
): EvalResult {
	return scoreNodeList(
		evalCase,
		results.map((result) => result.node),
		latencyMs,
	);
}

export function scoreContext(
	evalCase: EvalCase,
	context: ContextOutput,
	latencyMs: number,
): EvalResult {
	const nodesById = new Map<string, NodeRef>();
	for (const node of context.entryPoints) nodesById.set(node.id, node);
	for (const node of context.subgraph.nodes) nodesById.set(node.id, node);

	const base = scoreNodeList(evalCase, [...nodesById.values()], latencyMs);
	return {
		...base,
		mrr: reciprocalRank(evalCase.expectedSymbols, context.entryPoints),
	};
}

function scoreNodeList(
	evalCase: EvalCase,
	nodes: NodeRef[],
	latencyMs: number,
): EvalResult {
	const nodeNames = nodes.map((node) => node.name.toLowerCase());
	const found: string[] = [];
	const missed: string[] = [];

	for (const expected of evalCase.expectedSymbols) {
		if (nodeNames.includes(expected.toLowerCase())) found.push(expected);
		else missed.push(expected);
	}

	const recall =
		evalCase.expectedSymbols.length > 0
			? found.length / evalCase.expectedSymbols.length
			: 0;
	const mrr = reciprocalRank(evalCase.expectedSymbols, nodes);

	return {
		caseId: evalCase.id,
		pass: recall >= PASS_THRESHOLD,
		recall,
		mrr,
		found,
		missed,
		latencyMs,
	};
}

function reciprocalRank(expectedSymbols: string[], nodes: NodeRef[]): number {
	const expected = new Set(
		expectedSymbols.map((symbol) => symbol.toLowerCase()),
	);
	const index = nodes.findIndex((node) =>
		expected.has(node.name.toLowerCase()),
	);
	return index === -1 ? 0 : 1 / (index + 1);
}
