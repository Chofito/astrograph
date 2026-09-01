import { describe, expect, test } from "bun:test";
import {
	allDiagnosticCodes,
	categoryOf,
	countByCategory,
	degradesCompleteness,
	DIAGNOSTIC_REGISTRY,
	type DiagnosticCategory,
	emptyDiagnosticCounts,
	hasCoverageGap,
	isDiagnosticCode,
} from "./diagnostics";
import type { ExtractionError } from "./types";

const CATEGORIES: DiagnosticCategory[] = [
	"coverage_gap",
	"semantic_uncertainty",
	"configuration",
	"diagnostic",
];

function error(
	code: ExtractionError["code"],
	severity: ExtractionError["severity"] = "warning",
): ExtractionError {
	return { message: "irrelevant text", severity, code };
}

describe("the registry is exhaustive", () => {
	test("every registered code has a category from the closed set", () => {
		for (const code of allDiagnosticCodes()) {
			const definition = DIAGNOSTIC_REGISTRY[code];
			expect(CATEGORIES).toContain(definition.category);
			expect(typeof definition.degradesCompleteness).toBe("boolean");
			expect(definition.summary.length).toBeGreaterThan(0);
		}
	});

	test("every code a backend can emit is registered", () => {
		// The union in `ExtractionError["code"]` is what backends may write; if one
		// of these ever loses its entry the registry stops being exhaustive.
		const emitted = [
			"FILE_TOO_LARGE",
			"NO_BACKEND",
			"PARSE_ERROR",
			"RESOLVE_ERROR",
			"TREE_SITTER_UNAVAILABLE",
			"TREE_SITTER_GRAMMAR_MISSING",
			"TREE_SITTER_PARSE_ERROR",
			"PHP_CALL_UNRESOLVED",
			"PASS_A_NODE_DROPPED",
		];
		for (const code of emitted) {
			expect(isDiagnosticCode(code)).toBe(true);
		}
	});

	test("codes are stable identifiers, never prose", () => {
		for (const code of allDiagnosticCodes()) {
			expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
		}
	});
});

describe("categoryOf", () => {
	test("classifies each emitted code", () => {
		expect(categoryOf("PARSE_ERROR")).toBe("coverage_gap");
		expect(categoryOf("RESOLVE_ERROR")).toBe("coverage_gap");
		expect(categoryOf("TREE_SITTER_PARSE_ERROR")).toBe("coverage_gap");
		expect(categoryOf("PHP_CALL_UNRESOLVED")).toBe("semantic_uncertainty");
		expect(categoryOf("PASS_A_NODE_DROPPED")).toBe("diagnostic");
		expect(categoryOf("FILE_TOO_LARGE")).toBe("configuration");
		expect(categoryOf("NO_BACKEND")).toBe("configuration");
		expect(categoryOf("TREE_SITTER_UNAVAILABLE")).toBe("configuration");
		expect(categoryOf("TREE_SITTER_GRAMMAR_MISSING")).toBe("configuration");
		expect(categoryOf("UNKNOWN_CONFIG_KEY")).toBe("configuration");
	});

	test("an unknown code is a diagnostic, never silently harmless coverage", () => {
		// An index written by another build must stay readable, but an unknown
		// code must not be able to claim a file is complete.
		expect(categoryOf("WRITTEN_BY_A_FUTURE_BUILD")).toBe("diagnostic");
		expect(categoryOf(undefined)).toBe("diagnostic");
		expect(degradesCompleteness("WRITTEN_BY_A_FUTURE_BUILD")).toBe(false);
	});
});

describe("degradesCompleteness is not the same question as category", () => {
	test("a defect with no content cost does not degrade completeness", () => {
		// The Pass A row is kept, so the user loses nothing.
		expect(categoryOf("PASS_A_NODE_DROPPED")).toBe("diagnostic");
		expect(degradesCompleteness("PASS_A_NODE_DROPPED")).toBe(false);
	});

	test("a configuration exclusion is not a defect but does hide content", () => {
		expect(categoryOf("FILE_TOO_LARGE")).toBe("configuration");
		expect(degradesCompleteness("FILE_TOO_LARGE")).toBe(true);
	});

	test("invalid configuration input never degrades a persisted answer", () => {
		// Bad config is rejected before a graph opens; nothing was indexed wrongly.
		expect(degradesCompleteness("UNKNOWN_CONFIG_KEY")).toBe(false);
	});
});

describe("countByCategory and hasCoverageGap", () => {
	test("empty input produces zeroed counts and no gap", () => {
		expect(countByCategory(undefined)).toEqual(emptyDiagnosticCounts());
		expect(countByCategory([])).toEqual(emptyDiagnosticCounts());
		expect(hasCoverageGap(undefined)).toBe(false);
		expect(hasCoverageGap([])).toBe(false);
	});

	test("tallies across categories", () => {
		const counts = countByCategory([
			error("PARSE_ERROR", "error"),
			error("RESOLVE_ERROR", "error"),
			error("PHP_CALL_UNRESOLVED"),
			error("PASS_A_NODE_DROPPED"),
			error("FILE_TOO_LARGE"),
		]);
		expect(counts).toEqual({
			coverage_gap: 2,
			semantic_uncertainty: 1,
			configuration: 1,
			diagnostic: 1,
		});
	});

	test("a file carrying only a backend defect has no coverage gap", () => {
		expect(hasCoverageGap([error("PASS_A_NODE_DROPPED")])).toBe(false);
	});

	test("a file whose grammar was missing has a coverage gap", () => {
		expect(hasCoverageGap([error("TREE_SITTER_GRAMMAR_MISSING")])).toBe(true);
	});

	test("severity is not the trust signal; the code is", () => {
		// Same code, both severities: the classification must not move.
		expect(hasCoverageGap([error("PARSE_ERROR", "warning")])).toBe(true);
		expect(hasCoverageGap([error("PARSE_ERROR", "error")])).toBe(true);
	});

	test("message text never influences classification", () => {
		const misleading: ExtractionError = {
			message: "resolved successfully, everything is complete",
			severity: "warning",
			code: "TREE_SITTER_GRAMMAR_MISSING",
		};
		expect(hasCoverageGap([misleading])).toBe(true);
		expect(categoryOf(misleading.code)).toBe("configuration");
	});
});
