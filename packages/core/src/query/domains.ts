/**
 * What "complete" means for a given question (ADR-003, AG-206).
 *
 * Scoping coverage to the files a query happened to return is circular: a
 * reverse lookup that found nothing returns no files, so it reports complete
 * coverage over the empty set and presents "nothing calls this" with
 * `partial: false`. The domain says which files could *change* the answer, and
 * completeness is evaluated over those.
 */

import type { EdgeKind, Language } from "../types";

export type CompletenessDomain =
	/** `search`, `context`, `explore` — anything in the project may qualify. */
	| "global_discovery"
	/** `callers`, `impact` — any file may hold an incoming relation. */
	| "global_reverse"
	/** `trace` — any file may hold a hop on the path. */
	| "global_path"
	/** `callees` — only the source's own file and backend decide. */
	| "local_outgoing"
	/** `files` with a path or pattern — the selected membership. */
	| "explicit_scope"
	/** `status` — describes global state instead of hiding it behind partial. */
	| "descriptive";

/** Why an answer may be incomplete. Kinds are stable; details are for humans. */
export type PartialReasonKind =
	| "coverage_incomplete"
	| "capability_unsupported"
	| "search_truncated"
	| "semantic_uncertainty";

export interface PartialReason {
	kind: PartialReasonKind;
	/** One sentence. Never parsed. */
	detail: string;
	/** Bounded, sorted file list when the reason is file-specific. */
	files?: string[];
}

export interface DomainDescriptor {
	domain: CompletenessDomain;
	/**
	 * Files that could change this answer. Omitted means the whole project,
	 * which is what every `global_*` domain means.
	 */
	scopeFiles?: string[];
	/** Edge kinds the answer depends on. */
	requiredEdgeKinds?: EdgeKind[];
	/**
	 * For `local_outgoing`: the language of the source node, so only its owning
	 * backend's capabilities are consulted.
	 */
	sourceLanguage?: Language;
	/** True when a limit cut the search short rather than exhausting it. */
	truncated?: boolean;
}

/** A domain whose completeness depends on files the payload may not contain. */
export function isGlobalDomain(domain: CompletenessDomain): boolean {
	return (
		domain === "global_discovery" ||
		domain === "global_reverse" ||
		domain === "global_path"
	);
}

/**
 * A reverse or path question can be changed by a relation originating anywhere,
 * so every backend that owns files in the project must be able to produce the
 * required edge kinds. An outgoing question only depends on the source's own
 * backend.
 */
export function needsAllBackends(domain: CompletenessDomain): boolean {
	return domain === "global_reverse" || domain === "global_path";
}

/** Deterministic order, so two identical answers carry identical metadata. */
export function sortReasons(reasons: PartialReason[]): PartialReason[] {
	const rank: Record<PartialReasonKind, number> = {
		coverage_incomplete: 0,
		capability_unsupported: 1,
		semantic_uncertainty: 2,
		search_truncated: 3,
	};
	return [...reasons].sort(
		(a, b) => rank[a.kind] - rank[b.kind] || a.detail.localeCompare(b.detail),
	);
}
