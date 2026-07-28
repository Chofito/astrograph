import type { ContextOutput, SearchOutput } from "@astrograph/core";
import type { ExpectedSymbol } from "./types";

/**
 * A single case passes when at least this share of its expected symbols is
 * present in the answer.
 */
export const CASE_PASS_THRESHOLD = 0.5;

/**
 * Suite gate applied to mean recall across all cases.
 *
 * Deliberately a separate constant from {@link CASE_PASS_THRESHOLD}: the first
 * asks "is this one answer usable?", the second asks "is the index as a whole
 * good enough?". They happen to be equal today; keeping them apart means moving
 * one does not silently move the other. Override the suite gate per-run with
 * `--min-recall <n>`.
 */
export const SUITE_RECALL_THRESHOLD = 0.5;

/** Anything with a name we can match an expectation against. */
export interface MatchTarget {
	name: string;
	filePath?: string;
	kind?: string;
}

export interface ScoreOutcome {
	pass: boolean;
	recall: number;
	mrr: number;
	found: string[];
	missed: string[];
}

interface ExpectedSpec {
	name: string;
	file?: string;
	kind?: string;
}

/**
 * The one and only scorer. Every API funnels through here so recall and MRR are
 * computed identically; there is intentionally no per-API copy.
 */
export function scoreNodeList(
	expectedSymbols: ExpectedSymbol[],
	nodes: MatchTarget[],
): ScoreOutcome {
	const specs = expectedSymbols.map(normalizeExpected);
	const found: string[] = [];
	const missed: string[] = [];

	for (const spec of specs) {
		if (nodes.some((node) => matchesSpec(node, spec))) found.push(label(spec));
		else missed.push(label(spec));
	}

	const recall = specs.length > 0 ? found.length / specs.length : 0;

	return {
		pass: specs.length > 0 && recall >= CASE_PASS_THRESHOLD,
		recall,
		mrr: reciprocalRank(specs, nodes),
		found,
		missed,
	};
}

export function scoreSearch(
	expectedSymbols: ExpectedSymbol[],
	results: SearchOutput,
): ScoreOutcome {
	return scoreNodeList(
		expectedSymbols,
		results.map((result) => result.node),
	);
}

/**
 * Context recall is measured over the whole returned subgraph, but MRR is
 * measured over `entryPoints` only — that is the ranked list the caller reads
 * first.
 */
export function scoreContext(
	expectedSymbols: ExpectedSymbol[],
	context: ContextOutput,
): ScoreOutcome {
	const nodesById = new Map<string, MatchTarget>();
	for (const node of context.entryPoints) nodesById.set(node.id, node);
	for (const node of context.subgraph.nodes) nodesById.set(node.id, node);

	const base = scoreNodeList(expectedSymbols, [...nodesById.values()]);
	return {
		...base,
		mrr: reciprocalRank(
			expectedSymbols.map(normalizeExpected),
			context.entryPoints,
		),
	};
}

export function expectedLabel(expected: ExpectedSymbol): string {
	return label(normalizeExpected(expected));
}

function normalizeExpected(expected: ExpectedSymbol): ExpectedSpec {
	return typeof expected === "string" ? { name: expected } : expected;
}

function label(spec: ExpectedSpec): string {
	const suffix = [
		spec.kind === undefined ? "" : `:${spec.kind}`,
		spec.file === undefined ? "" : `@${basename(spec.file)}`,
	].join("");
	return `${spec.name}${suffix}`;
}

function matchesSpec(node: MatchTarget, spec: ExpectedSpec): boolean {
	if (node.name.toLowerCase() !== spec.name.toLowerCase()) return false;
	if (spec.kind !== undefined && node.kind !== spec.kind) return false;
	if (spec.file !== undefined && !pathContains(node.filePath, spec.file))
		return false;
	return true;
}

function pathContains(filePath: string | undefined, needle: string): boolean {
	if (filePath === undefined) return false;
	return normalizeSlashes(filePath).includes(normalizeSlashes(needle));
}

function normalizeSlashes(value: string): string {
	return value.replaceAll("\\", "/").toLowerCase();
}

function basename(filePath: string): string {
	const parts = normalizeSlashes(filePath).split("/");
	return parts[parts.length - 1] ?? filePath;
}

function reciprocalRank(specs: ExpectedSpec[], nodes: MatchTarget[]): number {
	const index = nodes.findIndex((node) =>
		specs.some((spec) => matchesSpec(node, spec)),
	);
	return index === -1 ? 0 : 1 / (index + 1);
}
