/**
 * The trust taxonomy: what a diagnostic *means*, separate from where a file is
 * in its lifecycle.
 *
 * `pending`, `parsed`, and `resolved` answer "how far did the pipeline get for
 * this file". They do not answer "is what we know good enough to trust this
 * answer". A file can be `resolved` — every phase ran to completion — and still
 * be missing content, because the grammar was unavailable or the file exceeded
 * the size limit. Conflating the two is how a graph reports a confident empty
 * result.
 *
 * This module is the single, versioned, exhaustive registry mapping every
 * emitted diagnostic code to its category. Nothing anywhere may infer behavior
 * from an error's `message` text: the code is the contract, the message is for
 * humans.
 */

import type { ConfigDiagnosticCode } from "./config";
import type { ExtractionError } from "./types";

/**
 * Bump when a code is added, removed, or re-categorized. It participates in the
 * index identity, so a taxonomy change re-derives persisted diagnostics instead
 * of leaving rows classified under the old meaning.
 */
export const DIAGNOSTIC_REGISTRY_VERSION = "1";

/**
 * What a diagnostic says about trust.
 *
 * - `coverage_gap` — content that should be in the graph is missing or partial
 *   for this file. A query whose domain includes the file may be incomplete.
 * - `semantic_uncertainty` — the content exists, but a specific relationship
 *   could not be proven to a single target. The fact is honest, not absent.
 * - `configuration` — configuration or the environment kept work from
 *   happening. User-actionable, and usually also degrades completeness.
 * - `diagnostic` — evidence of an internal defect. Visible on purpose, but it
 *   does not by itself make an answer less complete.
 */
export type DiagnosticCategory =
	| "coverage_gap"
	| "semantic_uncertainty"
	| "configuration"
	| "diagnostic";

/** Every diagnostic code extraction may attach to a file record. */
export type ExtractionDiagnosticCode =
	| "FILE_TOO_LARGE"
	| "NO_BACKEND"
	| "PARSE_ERROR"
	| "RESOLVE_ERROR"
	| "TREE_SITTER_UNAVAILABLE"
	| "TREE_SITTER_GRAMMAR_MISSING"
	| "TREE_SITTER_PARSE_ERROR"
	| "PHP_CALL_UNRESOLVED"
	| "PASS_A_NODE_DROPPED";

/** Extraction plus configuration codes: the complete diagnostic vocabulary. */
export type DiagnosticCode = ExtractionDiagnosticCode | ConfigDiagnosticCode;

export interface DiagnosticDefinition {
	category: DiagnosticCategory;
	/**
	 * Whether the presence of this code can make an otherwise complete answer
	 * incomplete. Kept separate from `category` because the two questions differ:
	 * `PASS_A_NODE_DROPPED` is a real defect that costs the user nothing, and a
	 * `configuration` exclusion is not a defect but does hide content.
	 *
	 * AG-206 decides whether a given query's domain actually reaches the file;
	 * this flag only says the code is capable of mattering.
	 */
	degradesCompleteness: boolean;
	/** One line, for operators reading `status`. Never parsed. */
	summary: string;
}

/**
 * The exhaustive table. `Record<DiagnosticCode, …>` is the enforcement: adding a
 * code to the union without classifying it fails to typecheck.
 */
export const DIAGNOSTIC_REGISTRY: Record<DiagnosticCode, DiagnosticDefinition> =
	{
		// ---- Extraction: configuration and environment kept work from happening.
		FILE_TOO_LARGE: {
			category: "configuration",
			degradesCompleteness: true,
			summary: "File exceeded maxFileSizeBytes and was not extracted.",
		},
		NO_BACKEND: {
			category: "configuration",
			degradesCompleteness: true,
			summary: "No enabled language backend claims this file's extension.",
		},
		TREE_SITTER_UNAVAILABLE: {
			category: "configuration",
			degradesCompleteness: true,
			summary: "The tree-sitter runtime could not be initialized.",
		},
		TREE_SITTER_GRAMMAR_MISSING: {
			category: "configuration",
			degradesCompleteness: true,
			summary: "The grammar this file needs is not loaded.",
		},

		// ---- Extraction: content that should exist is missing or partial.
		PARSE_ERROR: {
			category: "coverage_gap",
			degradesCompleteness: true,
			summary: "Structural extraction failed; this file's symbols are partial.",
		},
		TREE_SITTER_PARSE_ERROR: {
			category: "coverage_gap",
			degradesCompleteness: true,
			summary: "Tree-sitter reported a parse error; nodes may be missing.",
		},
		RESOLVE_ERROR: {
			category: "coverage_gap",
			degradesCompleteness: true,
			summary: "Semantic resolution failed; this file's edges are partial.",
		},

		// ---- Extraction: the fact exists, its target does not.
		PHP_CALL_UNRESOLVED: {
			category: "semantic_uncertainty",
			degradesCompleteness: true,
			summary: "A PHP call site could not be proven to a single target.",
		},

		// ---- Extraction: defect evidence with no completeness cost.
		PASS_A_NODE_DROPPED: {
			category: "diagnostic",
			degradesCompleteness: false,
			summary:
				"An enricher omitted a Pass A node. The row is kept, so no content is lost; the backend's identity contract is broken.",
		},

		// ---- Configuration parsing. Invalid configuration is rejected before a
		// graph is opened, so these never degrade a persisted answer.
		CONFIG_ROOT_NOT_OBJECT: cfg("Configuration root is not an object."),
		UNKNOWN_CONFIG_KEY: cfg("Unknown configuration key."),
		CONFIG_GLOB_LIST_TYPE: cfg("Glob list is not an array."),
		CONFIG_GLOB_TYPE: cfg("Glob entry is not a string."),
		CONFIG_GLOB_EMPTY: cfg("Glob entry is empty."),
		CONFIG_GLOB_NOT_PROJECT_RELATIVE: cfg("Glob escapes the project root."),
		CONFIG_MAX_FILE_SIZE_BYTES_INVALID: cfg("maxFileSizeBytes is invalid."),
		CONFIG_WATCH_DEBOUNCE_MS_INVALID: cfg("watchDebounceMs is invalid."),
		CONFIG_TSCONFIG_PATH_TYPE: cfg("tsconfigPath is not a string."),
		CONFIG_TSCONFIG_PATH_EMPTY: cfg("tsconfigPath is empty."),
		CONFIG_TSCONFIG_PATH_NOT_PROJECT_RELATIVE: cfg(
			"tsconfigPath escapes the project root.",
		),
		CONFIG_BACKENDS_NOT_OBJECT: cfg("backends is not an object."),
		CONFIG_BACKEND_NOT_OBJECT: cfg("A backend override is not an object."),
		CONFIG_BACKEND_BOOLEAN_INVALID: cfg(
			"A backend override flag is not a boolean.",
		),
		UNKNOWN_BACKEND_ID: cfg("Unknown backend id."),
		UNKNOWN_BACKEND_KEY: cfg("Unknown key inside a backend override."),
	};

function cfg(summary: string): DiagnosticDefinition {
	return { category: "configuration", degradesCompleteness: false, summary };
}

/** Every code in the registry, sorted, for status output and tests. */
export function allDiagnosticCodes(): DiagnosticCode[] {
	return (Object.keys(DIAGNOSTIC_REGISTRY) as DiagnosticCode[]).sort();
}

export function isDiagnosticCode(code: string): code is DiagnosticCode {
	return Object.hasOwn(DIAGNOSTIC_REGISTRY, code);
}

/**
 * The category for a code. An unregistered code is reported as `diagnostic`
 * rather than throwing: a persisted index written by another build must stay
 * readable, and an unknown code must never be silently treated as harmless
 * coverage. Callers that need to know use {@link isDiagnosticCode}.
 */
export function categoryOf(code: string | undefined): DiagnosticCategory {
	if (code === undefined || !isDiagnosticCode(code)) return "diagnostic";
	return DIAGNOSTIC_REGISTRY[code].category;
}

/** Whether this code can make an answer less complete. Unknown codes cannot. */
export function degradesCompleteness(code: string | undefined): boolean {
	if (code === undefined || !isDiagnosticCode(code)) return false;
	return DIAGNOSTIC_REGISTRY[code].degradesCompleteness;
}

export type DiagnosticCounts = Record<DiagnosticCategory, number>;

export function emptyDiagnosticCounts(): DiagnosticCounts {
	return {
		coverage_gap: 0,
		semantic_uncertainty: 0,
		configuration: 0,
		diagnostic: 0,
	};
}

/** Tally a file's diagnostics by category. Order-independent and pure. */
export function countByCategory(
	errors: readonly ExtractionError[] | undefined,
): DiagnosticCounts {
	const counts = emptyDiagnosticCounts();
	for (const error of errors ?? []) {
		counts[categoryOf(error.code)] += 1;
	}
	return counts;
}

/**
 * Whether a file carries evidence that content is missing, regardless of its
 * lifecycle state. This is the predicate that makes `resolved` stop implying
 * "complete": a fully resolved file whose grammar was unavailable answers
 * `true` here.
 */
export function hasCoverageGap(
	errors: readonly ExtractionError[] | undefined,
): boolean {
	return (errors ?? []).some((error) => degradesCompleteness(error.code));
}
