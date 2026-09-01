/**
 * One answer to "does this file belong to the graph, and which backend owns it".
 *
 * Before this module the question was answered in at least four places with
 * subtly different rules: the scanner applied include/exclude/gitignore, the
 * indexer re-checked size inside Pass A, `beginPass` re-derived backend
 * ownership by walking the registry again, and coverage counted whatever
 * happened to be persisted. Two definitions of membership is how an oversized
 * file still reaches a backend's `loadProject`, and how a disabled backend
 * leaves rows behind that queries keep answering from.
 *
 * The classification is computed once per pass and every consumer reads the
 * same `Membership` snapshot.
 */

import type { NormalizedAstrographConfig } from "./config";
import type { LanguageRegistry } from "./extraction/registry";
import { languageFromPath } from "./extraction/shared/language";
import type { Language } from "./types";

/** Why a path is not part of the active graph. Stable, and never prose. */
export type EligibilityReason =
	/**
	 * The scanner did not yield this path under the current configuration:
	 * `include`/`exclude`, `.gitignore`, or a hard-excluded directory. The
	 * scanner owns those rules; duplicating its matching here would recreate the
	 * second definition this module exists to remove.
	 */
	| "out_of_scope"
	/** No registered backend claims the extension. */
	| "no_backend"
	/** A shipped backend claims it, but configuration disabled that backend. */
	| "backend_disabled"
	/** Larger than `maxFileSizeBytes`. Recorded as evidence, never parsed. */
	| "too_large"
	/** The path could not be stat'ed: deleted between scan and classification. */
	| "missing";

/** The canonical per-path membership decision. */
export interface IndexEligibility {
	path: string;
	backendId?: string;
	language?: Language;
	eligible: boolean;
	reason?: EligibilityReason;
	/** Size in bytes when it could be read; evidence for `too_large`. */
	size?: number;
}

/** The whole project's membership for one pass. Deterministic and ordered. */
export interface Membership {
	/** Every classified path, sorted by path. */
	readonly all: readonly IndexEligibility[];
	/** Eligible entries only, sorted by path. */
	readonly eligible: readonly IndexEligibility[];
	/**
	 * Non-eligible entries that still deserve a persisted record, sorted. A path
	 * that is merely `out_of_scope` is not here: it is not evidence, it simply is
	 * not part of the project.
	 */
	readonly recordable: readonly IndexEligibility[];
	/** Eligible paths per backend id, each list sorted; backend ids sorted. */
	readonly byBackend: ReadonlyMap<string, readonly string[]>;
	get(path: string): IndexEligibility | undefined;
	isEligible(path: string): boolean;
}

export interface EligibilityOptions {
	registry: LanguageRegistry;
	config: NormalizedAstrographConfig;
	/**
	 * Extension → backend id for every *shipped* backend, enabled or not. Lets a
	 * disabled backend's files report `backend_disabled` instead of masquerading
	 * as an unsupported extension.
	 */
	shippedExtensionOwners?: ReadonlyMap<string, string>;
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 2_000_000;

/**
 * Classifies one path. Pure, and independent of any filesystem: `size` is
 * supplied by the caller so the same rules apply to a scanned file, a persisted
 * row, and a watch event.
 */
export function classifyPath(
	path: string,
	options: EligibilityOptions & { size?: number; inScanScope?: boolean },
): IndexEligibility {
	const normalized = normalizePath(path);

	if (options.inScanScope === false) {
		return { path: normalized, eligible: false, reason: "out_of_scope" };
	}

	const backend = options.registry.backendForPath(normalized);
	if (backend === undefined) {
		const owner = options.shippedExtensionOwners?.get(
			extensionOf(normalized),
		);
		return {
			path: normalized,
			eligible: false,
			reason: owner === undefined ? "no_backend" : "backend_disabled",
			backendId: owner,
		};
	}

	const language = languageFromPath(normalized);
	const base: IndexEligibility = {
		path: normalized,
		backendId: backend.id,
		eligible: true,
		...(language === undefined ? {} : { language }),
	};

	if (options.size === undefined) {
		return { ...base, eligible: false, reason: "missing" };
	}

	const limit = options.config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
	if (options.size > limit) {
		return {
			...base,
			size: options.size,
			eligible: false,
			reason: "too_large",
		};
	}

	return { ...base, size: options.size };
}

export interface BuildMembershipInput extends EligibilityOptions {
	/** Paths the scanner yielded under the current configuration. */
	scanned: readonly string[];
	/**
	 * Paths already persisted. Any that the scanner no longer yields are
	 * classified `out_of_scope` so a later phase can retire them.
	 */
	known?: readonly string[];
	/** Byte size, or `undefined` when the path could not be stat'ed. */
	sizeOf: (path: string) => Promise<number | undefined>;
}

/**
 * Classify a whole project once. Ordering is by path throughout and never
 * depends on registration order or SQLite row order, so two runs over the same
 * state produce byte-identical membership.
 */
export async function buildMembership(
	input: BuildMembershipInput,
): Promise<Membership> {
	const scanned = new Set(input.scanned.map(normalizePath));
	const paths = new Set<string>(scanned);
	for (const path of input.known ?? []) paths.add(normalizePath(path));

	const all: IndexEligibility[] = [];
	for (const path of [...paths].sort(compareStrings)) {
		if (!scanned.has(path)) {
			all.push({ path, eligible: false, reason: "out_of_scope" });
			continue;
		}
		all.push(
			classifyPath(path, {
				registry: input.registry,
				config: input.config,
				...(input.shippedExtensionOwners === undefined
					? {}
					: { shippedExtensionOwners: input.shippedExtensionOwners }),
				size: await input.sizeOf(path),
			}),
		);
	}

	return materialize(all);
}

/** Build the derived views once, so consumers never re-sort or re-group. */
export function materialize(entries: readonly IndexEligibility[]): Membership {
	const all = [...entries].sort((a, b) => compareStrings(a.path, b.path));
	const byPath = new Map(all.map((entry) => [entry.path, entry]));
	const eligible = all.filter((entry) => entry.eligible);

	// `out_of_scope` is not evidence: the file is simply not part of the project,
	// and persisting a row for it would make the graph claim knowledge of it.
	const recordable = all.filter(
		(entry) => !entry.eligible && entry.reason !== "out_of_scope",
	);

	const grouped = new Map<string, string[]>();
	for (const entry of eligible) {
		if (entry.backendId === undefined) continue;
		const bucket = grouped.get(entry.backendId);
		if (bucket) bucket.push(entry.path);
		else grouped.set(entry.backendId, [entry.path]);
	}
	const byBackend = new Map<string, readonly string[]>(
		[...grouped.entries()]
			.sort(([a], [b]) => compareStrings(a, b))
			.map(([id, files]) => [id, files.sort(compareStrings)]),
	);

	return {
		all,
		eligible,
		recordable,
		byBackend,
		get: (path) => byPath.get(normalizePath(path)),
		isEligible: (path) => byPath.get(normalizePath(path))?.eligible === true,
	};
}

/** Human-facing evidence for a non-eligible path. Codes stay the contract. */
export function eligibilityEvidence(entry: IndexEligibility): {
	code: "FILE_TOO_LARGE" | "NO_BACKEND";
	message: string;
} | null {
	switch (entry.reason) {
		case "too_large":
			return {
				code: "FILE_TOO_LARGE",
				message: `File exceeds maxFileSizeBytes (${entry.size ?? "unknown"} bytes)`,
			};
		case "no_backend":
			return {
				code: "NO_BACKEND",
				message: `No language backend claims ${entry.path}`,
			};
		case "backend_disabled":
			return {
				code: "NO_BACKEND",
				message: `Backend "${entry.backendId}" is disabled, so ${entry.path} is not indexed`,
			};
		default:
			return null;
	}
}

function extensionOf(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
