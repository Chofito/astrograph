import {
	canonicalize,
	type NormalizedEdge,
	type NormalizedFile,
	type NormalizedIndex,
	type NormalizedNode,
} from "../../src/testing/normalize";
import type { PipelineSnapshot, ProbeOutcome } from "./harness";

/**
 * Attributable comparison of two oracle snapshots (AG-302, AG-307).
 *
 * `expect(a).toEqual(b)` proves equality and says almost nothing about *what*
 * diverged: a four-route matrix row that fails needs to name the table, the
 * file and the backend, or the reader has to diff two thousand-line JSON dumps
 * to learn that one edge lost its resolution state.
 *
 * So every comparison here is by *identity* — a file by its path, a node by its
 * id, an edge by source/kind/target/line/column, a probe by its name — and a
 * mismatch is reported per differing field. Row counts are deliberately not a
 * comparison: two graphs with the same number of edges pointing at different
 * targets are not the same graph.
 */

export type DiscrepancyScope = "files" | "nodes" | "edges" | "envelopes";

export type DiscrepancyKind = "missing" | "unexpected" | "changed";

export interface Discrepancy {
	/** Which table or domain the difference is in. */
	scope: DiscrepancyScope;
	kind: DiscrepancyKind;
	/** Identity of the differing row: a path, a node id, an edge key, a probe. */
	key: string;
	/**
	 * Which backend's proof this row depends on, when the row itself says.
	 *
	 * A node carries its language; an edge carries the provenance of whatever
	 * produced it. A mixed-language fixture needs this to say "PHP diverged"
	 * rather than "something diverged" (AG-305).
	 */
	attribution?: string;
	/** File the row belongs to, when it is not the key itself. */
	filePath?: string;
	/** Field-level differences, sorted, for a `changed` row. */
	fields?: FieldDifference[];
}

export interface FieldDifference {
	field: string;
	actual: string;
	expected: string;
}

/**
 * Compare two snapshots and return every difference, deterministically ordered
 * by scope, then key, then kind. An empty array means the two snapshots are
 * equal under the AG-301 oracle.
 */
export function compareSnapshots(
	actual: PipelineSnapshot,
	expected: PipelineSnapshot,
): Discrepancy[] {
	return [
		...compareGraphs(actual.graph, expected.graph),
		...compareEnvelopeSets(actual.envelopes, expected.envelopes),
	].sort(compareDiscrepancies);
}

/** Graph-only comparison, for callers that took no envelopes. */
export function compareGraphs(
	actual: NormalizedIndex,
	expected: NormalizedIndex,
): Discrepancy[] {
	return [
		...compareRows({
			scope: "files",
			actual: actual.files,
			expected: expected.files,
			identity: (file: NormalizedFile) => file.path,
			attribution: (file: NormalizedFile) => file.language,
		}),
		...compareRows({
			scope: "nodes",
			actual: actual.nodes,
			expected: expected.nodes,
			identity: (node: NormalizedNode) => node.id,
			attribution: (node: NormalizedNode) => node.language,
			filePath: (node: NormalizedNode) => node.filePath,
		}),
		...compareRows({
			scope: "edges",
			actual: actual.edges,
			expected: expected.edges,
			identity: edgeKey,
			attribution: (edge: NormalizedEdge) => edge.provenance,
		}),
	].sort(compareDiscrepancies);
}

function compareEnvelopeSets(
	actual: Record<string, ProbeOutcome>,
	expected: Record<string, ProbeOutcome>,
): Discrepancy[] {
	return compareRows({
		scope: "envelopes",
		actual: Object.entries(actual).map(([name, envelope]) => ({
			name,
			envelope,
		})),
		expected: Object.entries(expected).map(([name, envelope]) => ({
			name,
			envelope,
		})),
		identity: (entry: { name: string }) => entry.name,
	});
}

/**
 * An edge's identity.
 *
 * Not `id`: the oracle drops it, because it is a SQLite rowid. What identifies
 * a relation is where it starts, what kind it is, where it points and where in
 * the source it was written — everything else (`resolutionState`, `confidence`,
 * `provenance`, `metadata`) is a *claim about* that relation, and a claim that
 * changed is exactly the divergence worth reporting.
 */
export function edgeKey(edge: NormalizedEdge): string {
	return [
		edge.source,
		edge.kind,
		edge.target ?? "-",
		edge.targetName ?? "-",
		edge.line ?? "-",
		edge.col ?? "-",
	].join("|");
}

interface RowComparison<T> {
	scope: DiscrepancyScope;
	actual: readonly T[];
	expected: readonly T[];
	identity(row: T): string;
	attribution?(row: T): string | undefined;
	filePath?(row: T): string | undefined;
}

function compareRows<T>(comparison: RowComparison<T>): Discrepancy[] {
	const actualByKey = indexByIdentity(comparison.actual, comparison.identity);
	const expectedByKey = indexByIdentity(
		comparison.expected,
		comparison.identity,
	);
	const discrepancies: Discrepancy[] = [];

	for (const [key, expectedRow] of expectedByKey) {
		const actualRow = actualByKey.get(key);
		if (actualRow === undefined) {
			discrepancies.push(describe(comparison, "missing", key, expectedRow));
			continue;
		}
		const fields = fieldDifferences(actualRow, expectedRow);
		if (fields.length > 0) {
			discrepancies.push({
				...describe(comparison, "changed", key, actualRow),
				fields,
			});
		}
	}

	for (const [key, actualRow] of actualByKey) {
		if (expectedByKey.has(key)) continue;
		discrepancies.push(describe(comparison, "unexpected", key, actualRow));
	}

	return discrepancies;
}

/**
 * Group rows by identity, keeping duplicates apart.
 *
 * Two rows can share an identity — the same call written twice on one line, for
 * instance — and silently collapsing them would let a lost duplicate compare
 * equal. A repeat gets `#2`, `#3`, … appended, so the count is part of the
 * identity.
 */
function indexByIdentity<T>(
	rows: readonly T[],
	identity: (row: T) => string,
): Map<string, T> {
	const byKey = new Map<string, T>();
	const seen = new Map<string, number>();
	for (const row of rows) {
		const base = identity(row);
		const occurrence = (seen.get(base) ?? 0) + 1;
		seen.set(base, occurrence);
		byKey.set(occurrence === 1 ? base : `${base}#${occurrence}`, row);
	}
	return byKey;
}

function describe<T>(
	comparison: RowComparison<T>,
	kind: DiscrepancyKind,
	key: string,
	row: T,
): Discrepancy {
	const attribution = comparison.attribution?.(row);
	const filePath = comparison.filePath?.(row);
	return {
		scope: comparison.scope,
		kind,
		key,
		...(attribution === undefined ? {} : { attribution }),
		...(filePath === undefined ? {} : { filePath }),
	};
}

/** Per-field differences between two rows of the same identity. */
function fieldDifferences(
	actual: unknown,
	expected: unknown,
): FieldDifference[] {
	const differences: FieldDifference[] = [];
	const fields = new Set([...keysOf(actual), ...keysOf(expected)]);

	for (const field of [...fields].sort()) {
		const actualValue = valueAt(actual, field);
		const expectedValue = valueAt(expected, field);
		const actualJson = canonicalize(actualValue);
		const expectedJson = canonicalize(expectedValue);
		if (actualJson === expectedJson) continue;
		differences.push({
			field,
			actual: actualJson,
			expected: expectedJson,
		});
	}

	return differences;
}

function keysOf(value: unknown): string[] {
	if (value === null || typeof value !== "object") return [];
	return Object.keys(value as Record<string, unknown>);
}

function valueAt(value: unknown, field: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[field];
}

const SCOPE_ORDER: Record<DiscrepancyScope, number> = {
	files: 0,
	nodes: 1,
	edges: 2,
	envelopes: 3,
};

function compareDiscrepancies(a: Discrepancy, b: Discrepancy): number {
	return (
		SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
		compareStrings(a.attribution ?? "", b.attribution ?? "") ||
		compareStrings(a.filePath ?? "", b.filePath ?? "") ||
		compareStrings(a.key, b.key) ||
		compareStrings(a.kind, b.kind)
	);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** A short, reviewable rendering of a discrepancy list for a failure message. */
export function formatDiscrepancies(
	discrepancies: readonly Discrepancy[],
	options: { limit?: number } = {},
): string {
	const limit = options.limit ?? 20;
	if (discrepancies.length === 0) return "no discrepancies";

	const lines = discrepancies.slice(0, limit).map((discrepancy) => {
		const where = [
			discrepancy.scope,
			discrepancy.attribution,
			discrepancy.filePath,
		]
			.filter((part) => part !== undefined && part.length > 0)
			.join("/");
		const fields = (discrepancy.fields ?? [])
			.map((field) => `${field.field}: ${field.actual} != ${field.expected}`)
			.join("; ");
		return `${where} ${discrepancy.kind} ${discrepancy.key}${
			fields.length === 0 ? "" : ` — ${fields}`
		}`;
	});

	if (discrepancies.length > limit) {
		lines.push(`… ${discrepancies.length - limit} more`);
	}
	return lines.join("\n");
}
