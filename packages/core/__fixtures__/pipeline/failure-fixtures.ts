import {
	GRAMMARLESS_EXTENSION,
	registryWithFailingParser,
	registryWithGrammarlessBackend,
	registryWithMissingGrammar,
} from "./failure-injection";
import type { FixtureFiles, PipelineManifest } from "./harness";
import {
	calleesProbe,
	callersProbe,
	filesProbe,
	searchProbe,
	statusProbe,
	traceProbe,
} from "./probes";

/**
 * AG-306: the failure-and-honesty matrix.
 *
 * Each fixture puts the pipeline in a state where it knows *less* than the
 * project contains, and pins two things: the persisted evidence that says why,
 * and what each query domain then claimed about itself. The shortcut these
 * fixtures exist to forbid is an index that produced no rows and reports
 * success — and its mirror image, an index that marks every answer `partial`
 * so that nothing can ever be wrong.
 *
 * | Fixture | Condition | Expected persisted code |
 * |---|---|---|
 * | `failure-coverage-gaps` | Oversized owned file | `FILE_TOO_LARGE` |
 * | `failure-coverage-gaps` | Owned extension with no grammar | `TREE_SITTER_UNAVAILABLE` |
 * | `failure-grammar-missing` | Recognized extension whose grammar fails to load | `TREE_SITTER_GRAMMAR_MISSING` |
 * | `failure-coverage-gaps` | Unresolved and ambiguous relations | edge states, `PHP_CALL_UNRESOLVED`-equivalent evidence |
 * | `failure-backend-extraction` | Backend Pass A failure, enricher present | `PARSE_ERROR` |
 * | `failure-backend-extraction-pass-a` | Backend Pass A failure, nothing to fall back on | `PARSE_ERROR`, zero nodes |
 * | `failure-unowned-and-disabled` | Extension no shipped backend claims, plus a disabled backend's extension | `NO_BACKEND` (twice, with different messages) |
 * | `failure-backend-disabled` | Backend turned off after indexing, default configuration | `NO_BACKEND`, and honest envelopes |
 * | `failure-capability-gap` | Pass-A-only backend, relational question | `capability_unsupported` reason |
 *
 * `src/ok.ts` is in every one of them. It is the control: a small, healthy,
 * self-contained file whose *outgoing* question can be answered completely even
 * while the project as a whole is degraded.
 */

/**
 * The healthy control file.
 *
 * Deliberately self-contained: `useHelper` calls `helper` in the same file, so
 * the `local_outgoing` domain for `useHelper` covers exactly one file, and that
 * file is fine. Any other file's problems are outside its domain, which is the
 * distinction ADR-003 and AG-206 exist to draw.
 */
const OK_SOURCE = `export function helper(): number {
	return 1;
}

export function useHelper(): number {
	return helper();
}
`;

/** Small enough that the size limit below never touches it. */
const SIZE_LIMIT = 512;

/**
 * An owned, enabled, eligible-by-extension file that exceeds the limit.
 *
 * The padding is a comment so the file stays valid TypeScript: the point is
 * that a *parseable* file is skipped for a configuration reason, not that
 * broken input is skipped.
 */
const OVERSIZED_SOURCE = `export function oversized(): number {
	return 2;
}
// ${"pad ".repeat(200)}
`;

/**
 * A merged function/namespace declaration, and a reference to it.
 *
 * Two declarations share one name, so the reference has more than one candidate
 * and the honest answer is `ambiguous` with the candidates recorded — not a
 * coin flip between them.
 */
const AMBIGUOUS_SOURCE = `function merged() {
	return 1;
}

namespace merged {
	export const tag = "ns";
}

export function readTag(): string {
	return merged.tag;
}
`;

/** An import of a module the project does not contain. */
const UNRESOLVED_SOURCE = `import { join } from "node:path";

export function describePath(): string {
	return join("a", "b");
}
`;

const BASE_FILES: FixtureFiles = { "src/ok.ts": OK_SOURCE };

/** One PHP class, shared by the two backend-visibility fixtures. */
const PHP_SERVICE_SOURCE = `<?php

namespace App;

class Service
{
    public function handle(): void
    {
    }
}
`;

/**
 * Probes chosen so that the four completeness domains are all represented and
 * so that at least one of them must come back complete.
 */
const HONESTY_PROBES = [
	// local_outgoing, scoped to `src/ok.ts`: must stay complete.
	calleesProbe("useHelper"),
	// global_reverse: any file could hold an incoming call, so a coverage gap
	// anywhere makes this partial.
	callersProbe("helper"),
	// global_discovery: partial for the same reason, with its own reason list.
	searchProbe("helper"),
	// global_path.
	traceProbe("useHelper", "helper"),
	// explicit_scope and descriptive.
	filesProbe(),
	statusProbe(),
];

export const FAILURE_COVERAGE_GAPS_MANIFEST: PipelineManifest = {
	id: "failure-coverage-gaps",
	description:
		"An oversized owned file, an owned extension with no tree-sitter grammar, and ambiguous plus unresolved relations, all visible as persisted evidence.",
	modes: { typescript: "enriched", php: "disabled" },
	config: { maxFileSizeBytes: SIZE_LIMIT },
	files: {
		...BASE_FILES,
		"src/oversized.ts": OVERSIZED_SOURCE,
		"src/ambiguous.ts": AMBIGUOUS_SOURCE,
		"src/unresolved.ts": UNRESOLVED_SOURCE,
		[`src/shader${GRAMMARLESS_EXTENSION}`]: "uniform float u_time;\n",
	},
	injection: { createRegistry: registryWithGrammarlessBackend },
	probes: HONESTY_PROBES,
};

export const FAILURE_BACKEND_EXTRACTION_MANIFEST: PipelineManifest = {
	id: "failure-backend-extraction",
	description:
		"A backend whose Pass A fails for one owned file: zero nodes, a persisted PARSE_ERROR, and an answer that does not pretend the file is empty.",
	modes: { typescript: "enriched", php: "disabled" },
	files: {
		...BASE_FILES,
		"src/broken.ts": "export function broken(): number {\n\treturn 3;\n}\n",
	},
	injection: {
		createRegistry: registryWithFailingParser("typescript", [
			{
				filePath: "src/broken.ts",
				code: "PARSE_ERROR",
				message: "injected Pass A failure",
			},
		]),
	},
	probes: HONESTY_PROBES,
};

/**
 * A file nobody claims at all, next to one whose backend is switched off.
 *
 * Two different classifications behind one code. `notes.txt` has no shipped
 * backend, so it needs an `include` entry to be scanned at all — nothing in the
 * registry claims `.txt`. `src/Service.php` is claimed by a shipped backend
 * that configuration disabled, and since the scanner covers every shipped
 * extension it is scanned whether or not `include` names it.
 *
 * Both end as `NO_BACKEND` records with zero nodes, and the message is what
 * separates "install a backend for this" from "re-enable the one you turned
 * off". The codes stay the contract; the messages are the actionable part.
 */
export const FAILURE_UNOWNED_AND_DISABLED_MANIFEST: PipelineManifest = {
	id: "failure-unowned-and-disabled",
	description:
		"An extension no shipped backend claims (reachable only through `include`) alongside a disabled backend's extension: both recorded as NO_BACKEND, with distinct messages.",
	modes: { typescript: "enriched", php: "disabled" },
	config: { include: ["**/*.ts", "**/*.txt", "**/*.php"] },
	files: {
		...BASE_FILES,
		"notes.txt": "No backend claims this file.\n",
		"src/Service.php": PHP_SERVICE_SOURCE,
	},
	probes: [...HONESTY_PROBES, searchProbe("handle")],
};

/**
 * Turning a backend off with no `include` at all — the default configuration.
 *
 * This fixture used to record a gap: the scanner's extension list came from
 * `registry.allExtensions()`, which omits a disabled backend, so no `.php` path
 * was scanned, membership classified the persisted path `out_of_scope` (not
 * `backend_disabled`), `out_of_scope` is not recordable, and the row was
 * deleted. A project whose entire PHP half was unindexed then answered every
 * query with `partial: false`.
 *
 * The scanner now covers every *shipped* backend's extensions, enabled or not,
 * so this is the fixture that holds that fix in place: the row survives with
 * the reason, and the envelopes say the project is incomplete. What it still
 * pins as imprecise is the *kind* of reason — a coverage gap rather than a
 * capability limit, since coverage is what the disabled backend's unindexed
 * files move. See the 0.1-C review's residual findings.
 */
export const FAILURE_BACKEND_DISABLED_MANIFEST: PipelineManifest = {
	id: "failure-backend-disabled",
	description:
		"A PHP file indexed by an enabled backend, then re-indexed with that backend disabled: its nodes are retired, a NO_BACKEND record survives with the actionable message, and global queries report themselves incomplete.",
	modes: { typescript: "enriched", php: "enriched" },
	files: { ...BASE_FILES, "src/Service.php": PHP_SERVICE_SOURCE },
	// Turning a backend off is only observable against an index that already
	// contains its rows. Before R2-1, with PHP off from the start the scanner
	// never yielded a `.php` path at all — `registry.allExtensions()` omitted
	// the disabled backend — so there was nothing to retire and nothing to
	// record. After R2-1 the scanner includes every shipped backend's
	// extensions even when that backend is disabled, so a PHP-off-from-the-
	// start run would still persist a `NO_BACKEND` row; it would never have
	// created the nodes this fixture exists to prove are retired. The
	// sequence below is therefore still required: index while PHP is on, then
	// reopen with it off. The surviving row uses `NO_BACKEND`; the envelope
	// reason remains `coverage_incomplete` rather than a capability limit
	// (`DEV-004`/`NEW-002`).
	async run(session) {
		await session.indexAll();
		await session.reopen({
			modes: { typescript: "enriched", php: "disabled" },
		});
		await session.indexAll();
	},
	probes: [
		searchProbe("handle"),
		callersProbe("helper"),
		calleesProbe("useHelper"),
		filesProbe(),
		statusProbe(),
	],
};

/**
 * The same injected Pass A failure with no enricher behind it.
 *
 * In the enriched fixture above the TypeScript enricher still contributes its
 * own node view for the failed file, so the graph recovers most of the content
 * and the diagnostic is what tells the user something went wrong. With the
 * enricher off there is nothing to fall back on: the file is owned, eligible,
 * enabled — and empty. That is the exact state AG-306 exists to keep from
 * looking like success.
 */
export const FAILURE_BACKEND_EXTRACTION_PASS_A_MANIFEST: PipelineManifest = {
	id: "failure-backend-extraction-pass-a",
	description:
		"A Pass-A-only backend whose parser fails for one owned file: zero nodes, a persisted PARSE_ERROR, and a file that is visibly known-and-empty.",
	modes: { typescript: "pass-a-only", php: "disabled" },
	files: {
		...BASE_FILES,
		"src/broken.ts": "export function broken(): number {\n\treturn 3;\n}\n",
	},
	injection: {
		createRegistry: registryWithFailingParser("typescript", [
			{
				filePath: "src/broken.ts",
				code: "PARSE_ERROR",
				message: "injected Pass A failure",
			},
		]),
	},
	probes: HONESTY_PROBES,
};

export const FAILURE_CAPABILITY_GAP_MANIFEST: PipelineManifest = {
	id: "failure-capability-gap",
	description:
		"A healthy Pass-A-only project: discovery is complete, every relational question is honestly unsupported, and no file carries a diagnostic.",
	modes: { typescript: "pass-a-only", php: "disabled" },
	files: BASE_FILES,
	probes: HONESTY_PROBES,
};

/**
 * A recognized extension whose grammar is not loaded.
 *
 * Distinct from the `.frag` `TREE_SITTER_UNAVAILABLE` row: the path maps to a
 * `TreeSitterLang`, the runtime is ready, and Pass A still emits only the file
 * node plus `TREE_SITTER_GRAMMAR_MISSING`. Pass-A-only so the TypeScript
 * enricher cannot recover structure and hide the file-only contract. The
 * injection lives on the private `createRegistry` seam and does not mutate the
 * process-global grammar cache.
 */
export const FAILURE_GRAMMAR_MISSING_MANIFEST: PipelineManifest = {
	id: "failure-grammar-missing",
	description:
		"A recognized TypeScript file whose grammar fails to load: the file remains represented, Pass A keeps only the file node, TREE_SITTER_GRAMMAR_MISSING is persisted, and query envelopes stay honest.",
	modes: { typescript: "pass-a-only", php: "disabled" },
	files: {
		...BASE_FILES,
		"src/gapped.ts":
			"export function gapped(): number {\n\treturn 4;\n}\n",
	},
	injection: {
		createRegistry: registryWithMissingGrammar("typescript", ["src/gapped.ts"]),
	},
	probes: HONESTY_PROBES,
};

export const FAILURE_MANIFESTS = [
	FAILURE_BACKEND_DISABLED_MANIFEST,
	FAILURE_BACKEND_EXTRACTION_MANIFEST,
	FAILURE_BACKEND_EXTRACTION_PASS_A_MANIFEST,
	FAILURE_CAPABILITY_GAP_MANIFEST,
	FAILURE_COVERAGE_GAPS_MANIFEST,
	FAILURE_GRAMMAR_MISSING_MANIFEST,
	FAILURE_UNOWNED_AND_DISABLED_MANIFEST,
] as const;
