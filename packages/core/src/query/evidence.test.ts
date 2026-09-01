import { describe, expect, test } from "bun:test";
import type { Edge } from "../types";
import {
	collectEvidence,
	evidenceNotes,
	hasUnprovenRelations,
	MAX_EVIDENCE_SAMPLES,
} from "./evidence";

/**
 * AG-207: node-shaped payloads drop `target === null` edges because there is no
 * node to show. Evidence is collected before that filter, so an empty result
 * cannot look identical to "this calls nothing".
 */

function edge(overrides: Partial<Edge> = {}): Edge {
	return {
		source: "src/a.ts::run",
		target: null,
		kind: "calls",
		resolutionState: "unresolved",
		confidence: "low",
		provenance: "tree-sitter",
		...overrides,
	};
}

describe("collectEvidence", () => {
	test("no edges produces no evidence", () => {
		expect(collectEvidence([])).toBeUndefined();
	});

	test("counts are exact and cover resolved edges too", () => {
		const evidence = collectEvidence([
			edge({ resolutionState: "resolved", target: "x" }),
			edge({ resolutionState: "unresolved", targetName: "save" }),
			edge({ resolutionState: "unresolved", targetName: "load" }),
			edge({ resolutionState: "ambiguous", targetName: "pick" }),
			edge({ resolutionState: "external", targetName: "lodash" }),
		]);

		expect(evidence?.counts).toEqual([
			{ resolutionState: "ambiguous", kind: "calls", count: 1 },
			{ resolutionState: "external", kind: "calls", count: 1 },
			{ resolutionState: "resolved", kind: "calls", count: 1 },
			{ resolutionState: "unresolved", kind: "calls", count: 2 },
		]);
	});

	test("samples exclude resolved edges and carry the location", () => {
		const evidence = collectEvidence([
			edge({ resolutionState: "resolved", target: "x" }),
			edge({ targetName: "save", line: 12, col: 4, provenance: "ts-compiler" }),
		]);

		expect(evidence?.samples).toEqual([
			{
				source: "src/a.ts::run",
				kind: "calls",
				resolutionState: "unresolved",
				targetName: "save",
				line: 12,
				col: 4,
				provenance: "ts-compiler",
			},
		]);
	});

	test("a backend-supplied reason is surfaced when present", () => {
		const evidence = collectEvidence([
			edge({ targetName: "save", metadata: { reason: "receiver type unknown" } }),
		]);
		expect(evidence?.samples[0]?.reason).toBe("receiver type unknown");
	});

	test("no source text or metadata beyond the declared projection leaks", () => {
		const evidence = collectEvidence([
			edge({
				targetName: "save",
				metadata: { snippet: "const secret = process.env.TOKEN", reason: "ok" },
			}),
		]);
		const sample = evidence?.samples[0] ?? {};
		expect(Object.keys(sample).sort()).toEqual([
			"kind",
			"provenance",
			"reason",
			"resolutionState",
			"source",
			"targetName",
		]);
	});

	test("samples are bounded and truncation is stated, counts stay exact", () => {
		const many = Array.from({ length: MAX_EVIDENCE_SAMPLES + 5 }, (_, i) =>
			edge({ targetName: `fn${String(i).padStart(2, "0")}` }),
		);
		const evidence = collectEvidence(many);

		expect(evidence?.samples.length).toBe(MAX_EVIDENCE_SAMPLES);
		expect(evidence?.truncated).toBe(true);
		expect(evidence?.counts[0]?.count).toBe(MAX_EVIDENCE_SAMPLES + 5);
		expect(evidenceNotes(evidence).at(-1)).toContain("counts above are exact");
	});

	test("ordering is deterministic regardless of input order", () => {
		const edges = [
			edge({ targetName: "zeta", line: 9 }),
			edge({ resolutionState: "ambiguous", targetName: "alpha" }),
			edge({ targetName: "alpha", line: 3 }),
		];
		const forward = collectEvidence(edges);
		const backward = collectEvidence([...edges].reverse());
		expect(forward).toEqual(backward);
		expect(forward?.samples.map((s) => s.targetName)).toEqual([
			"alpha",
			"alpha",
			"zeta",
		]);
	});
});

describe("external is a complete answer, not a failure", () => {
	test("external alone does not count as an unproven relation", () => {
		const evidence = collectEvidence([
			edge({ resolutionState: "external", targetName: "lodash" }),
		]);
		// A call into node_modules is a complete answer about a target outside
		// the project, not a gap in the graph.
		expect(hasUnprovenRelations(evidence)).toBe(false);
	});

	test("unresolved and ambiguous do count", () => {
		expect(
			hasUnprovenRelations(collectEvidence([edge({ targetName: "x" })])),
		).toBe(true);
		expect(
			hasUnprovenRelations(
				collectEvidence([edge({ resolutionState: "ambiguous" })]),
			),
		).toBe(true);
	});
});

describe("evidenceNotes", () => {
	test("mirrors the counts without repeating resolved edges", () => {
		const notes = evidenceNotes(
			collectEvidence([
				edge({ resolutionState: "resolved", target: "x" }),
				edge({ targetName: "save" }),
			]),
		);
		expect(notes).toEqual([
			"1 unresolved calls relation(s) could not be shown as nodes.",
		]);
	});

	test("is empty when there is nothing to say", () => {
		expect(evidenceNotes(undefined)).toEqual([]);
	});
});
