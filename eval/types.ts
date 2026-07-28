import type { Coverage, NodeKind } from "@astrograph/core";

export type EvalApi =
	| "search"
	| "context"
	| "callers"
	| "callees"
	| "impact"
	| "trace"
	| "node"
	| "explore"
	| "files";

/**
 * An expectation.
 *
 * A bare string matches on symbol name only, case-insensitively. That is fine
 * for names that are unique in the repo, and misleading for names that are not
 * (`search`, `extractNodes`, `meta`, ... all exist in several files). Use the
 * object form to pin a case down to a file and/or node kind.
 */
export type ExpectedSymbol =
	| string
	| {
			name: string;
			/** Case-insensitive substring of the node's file path. */
			file?: string;
			kind?: NodeKind;
	  };

interface EvalCaseBase {
	id: string;
	/**
	 * The primary input. For `files` this is the path prefix; for `trace` it is
	 * the source symbol; for everything else it is the query/symbol.
	 */
	query: string;
	expectedSymbols: ExpectedSymbol[];
	/** Why the case exists / how the expectation was derived. */
	why?: string;
}

/**
 * Discriminated per API so per-API inputs are required where they matter.
 * In particular `trace` cannot be written without a destination, which is what
 * previously allowed a case to silently trace a symbol to itself.
 */
export type EvalCase =
	| (EvalCaseBase & { api: "search"; kind?: NodeKind })
	| (EvalCaseBase & { api: "context"; maxSymbols?: number })
	| (EvalCaseBase & { api: "callers" | "callees" })
	| (EvalCaseBase & { api: "impact"; depth?: number })
	| (EvalCaseBase & { api: "node" })
	| (EvalCaseBase & { api: "explore"; maxFiles?: number })
	| (EvalCaseBase & { api: "files"; pattern?: string })
	| (EvalCaseBase & {
			api: "trace";
			traceTo: string;
			maxDepth?: number;
			/**
			 * Whether a path is expected to exist. Defaults to true. When false the
			 * case asserts the *absence* of a path, and recall is measured over the
			 * fallback `endpoints` payload instead of `hops`.
			 */
			expectPath?: boolean;
	  });

export interface EvalResult {
	caseId: string;
	api: EvalApi;
	arm: string;
	pass: boolean;
	recall: number;
	mrr: number;
	found: string[];
	missed: string[];
	latencyMs: number;
	/**
	 * How many symbols/entries the answer forces the caller to read. This is the
	 * guard against an enricher buying recall with an enormous payload.
	 */
	payloadSymbols: number;
	/** Honesty signals lifted verbatim from `ToolResult.meta`. */
	coverage?: Coverage;
	partial: boolean;
	/** `meta.notes` (ambiguous / unresolved / external edge warnings). */
	notes: string[];
	/** `trace` only: whether a real path was found (vs. the fallback payload). */
	pathFound?: boolean;
	/** Set when the API threw, e.g. `Symbol not found`. */
	error?: string;
}

export interface EvalSummary {
	cases: number;
	passed: number;
	errors: number;
	meanRecall: number;
	meanMRR: number;
	meanLatencyMs: number;
	meanPayloadSymbols: number;
	totalPayloadSymbols: number;
	/** Cases whose `meta.partial` was true — recall from those is not trustworthy. */
	partialCases: number;
	/** Worst resolved/total ratio seen across cases (1 = fully resolved index). */
	minCoverageRatio: number;
	/** No partial case, no error: recall can be read at face value. */
	honest: boolean;
}

export interface ArmReport {
	arm: string;
	description: string;
	repoPath: string;
	dbPath: string;
	reusedDb: boolean;
	results: EvalResult[];
	summary: EvalSummary;
}
