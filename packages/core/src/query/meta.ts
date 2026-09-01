import type { QueryBuilder } from "../db/queries";
import type { BackendStatus, ToolMeta } from "../types";
import {
	type DomainDescriptor,
	isGlobalDomain,
	needsAllBackends,
	type PartialReason,
	sortReasons,
} from "./domains";

export interface BuildMetaOptions {
	/**
	 * What "complete" means for this question. Omitting it is legacy behavior
	 * and treated as `global_discovery`, the most conservative domain.
	 */
	domain?: DomainDescriptor;
	/** Backends registered for this project, for capability evaluation. */
	backends?: readonly BackendStatus[];
	scopeFiles?: string[];
	pendingForFiles?: string[];
	forcePartial?: boolean;
	/** Extra human-facing notes the caller already computed. */
	notes?: string[];
	/** Extra structured reasons the caller already computed. */
	reasons?: PartialReason[];
}

const MAX_LISTED_FILES = 25;

/**
 * Build the query trust envelope.
 *
 * Three inputs decide `partial`: lifecycle coverage over the domain's files,
 * trust diagnostics over those same files (AG-201 — a `resolved` file whose
 * grammar was missing still cannot answer), and whether the backends that could
 * produce the required relations actually can.
 */
export function buildMeta(
	queries: QueryBuilder,
	options: BuildMetaOptions = {},
): ToolMeta {
	const domain = options.domain ?? { domain: "global_discovery" as const };
	const scopeFiles = options.scopeFiles ?? domain.scopeFiles;
	const coverage = queries.getCoverage(scopeFiles);
	const pendingFiles =
		options.pendingForFiles ?? queries.getPendingFiles(25, scopeFiles);

	const reasons: PartialReason[] = [...(options.reasons ?? [])];

	// `status` describes global state rather than hiding it behind partiality.
	if (domain.domain !== "descriptive") {
		reasons.push(
			...coverageReasons(queries, coverage, pendingFiles, scopeFiles),
		);
		reasons.push(...capabilityReasons(queries, domain, options.backends));
	}

	if (domain.truncated === true) {
		reasons.push({
			kind: "search_truncated",
			detail:
				"A result limit cut this search short; more matches may exist beyond it.",
		});
	}

	const sorted = sortReasons(reasons);
	const partial =
		options.forcePartial === true ||
		(domain.domain !== "descriptive" && sorted.length > 0);

	const notes = [
		...sorted.map((reason) => reason.detail),
		...(options.notes ?? []),
	].filter((note) => note.trim() !== "");

	return {
		coverage,
		partial,
		domain: domain.domain,
		reasons: sorted.length > 0 ? sorted : undefined,
		pendingFiles:
			pendingFiles.length > 0
				? pendingFiles.slice(0, MAX_LISTED_FILES)
				: undefined,
		notes: notes.length > 0 ? notes : undefined,
	};
}

function coverageReasons(
	queries: QueryBuilder,
	coverage: ToolMeta["coverage"],
	pendingFiles: string[],
	scopeFiles: string[] | undefined,
): PartialReason[] {
	const reasons: PartialReason[] = [];

	if (coverage.pending > 0 || coverage.parsed > 0) {
		reasons.push({
			kind: "coverage_incomplete",
			detail: `${coverage.pending + coverage.parsed} of ${coverage.total} files have not finished resolving.`,
			...(pendingFiles.length > 0
				? { files: pendingFiles.slice(0, MAX_LISTED_FILES) }
				: {}),
		});
	}

	// AG-201: lifecycle is not trust. A fully `resolved` project can still be
	// missing content, and a global answer over it is not complete.
	const gaps = queries.getFilesWithCoverageGap(scopeFiles);
	if (gaps.length > 0) {
		reasons.push({
			kind: "coverage_incomplete",
			detail: `${gaps.length} file(s) finished indexing but are missing content; see their diagnostics.`,
			files: gaps.slice(0, MAX_LISTED_FILES),
		});
	}

	return reasons;
}

function capabilityReasons(
	queries: QueryBuilder,
	domain: DomainDescriptor,
	backends: readonly BackendStatus[] | undefined,
): PartialReason[] {
	const required = domain.requiredEdgeKinds ?? [];
	if (required.length === 0 || backends === undefined) return [];

	// A backend with no files in this project cannot change any answer, so it
	// must not make one look partial. Disabling PHP in a pure TypeScript repo
	// should not degrade every `callers` result.
	const activeLanguages = new Set(queries.getLanguagesWithFiles());

	const candidates = needsAllBackends(domain.domain)
		? backends.filter((backend) =>
				backend.languages.some((language) => activeLanguages.has(language)),
			)
		: backends.filter(
				(backend) =>
					domain.sourceLanguage !== undefined &&
					backend.languages.includes(domain.sourceLanguage),
			);

	const reasons: PartialReason[] = [];
	for (const backend of candidates) {
		const supported = new Set(backend.capabilities.edgeKinds);
		const missing = required.filter((kind) => !supported.has(kind));
		if (missing.length === 0) continue;
		reasons.push({
			kind: "capability_unsupported",
			detail: `${backend.id} backend produces no ${missing.join("/")} edges, so relations originating in ${backend.languages.join("/")} files cannot appear here.`,
		});
	}

	return reasons.sort((a, b) => a.detail.localeCompare(b.detail));
}

/** Whether a domain evaluates completeness beyond the returned payload. */
export { isGlobalDomain };
