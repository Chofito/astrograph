import { type AstrographConfig, SHIPPED_BACKEND_IDS } from "../config";
import { DIAGNOSTIC_REGISTRY_VERSION } from "../diagnostics";
import type {
	BackendStatus,
	EdgeKind,
	Hasher,
	Language,
	LanguageBackend,
} from "../types";
import { createPhpBackend } from "./php/backend";
import {
	loadedGrammars,
	type TreeSitterLang,
	treeSitterLangFromPath,
	unavailableGrammars,
} from "./tree-sitter/grammars";
import { TypescriptLanguageBackend } from "./typescript/backend";

/** Authoritative mapping from file extensions to configured language backends. */
export class LanguageRegistry {
	private readonly backends: Map<string, LanguageBackend> = new Map();
	private readonly extensionToBackend: Map<string, LanguageBackend> = new Map();

	constructor(backends: LanguageBackend[]) {
		validateBackends(backends);
		for (const backend of backends) {
			this.backends.set(backend.id, backend);
			for (const ext of backend.extensions) {
				this.extensionToBackend.set(ext.toLowerCase(), backend);
			}
		}
	}

	/** The backend that owns a path, or undefined when nothing claims it. */
	backendForPath(filePath: string): LanguageBackend | undefined {
		const dot = filePath.lastIndexOf(".");
		if (dot === -1) return undefined;
		return this.extensionToBackend.get(filePath.slice(dot).toLowerCase());
	}

	backendById(id: string): LanguageBackend | undefined {
		return this.backends.get(id);
	}

	/** Single source of truth for which files are indexable at all. */
	allExtensions(): string[] {
		return [...this.extensionToBackend.keys()].sort();
	}

	/** Every language any registered backend claims to handle. */
	allLanguages(): Language[] {
		const languages = new Set<Language>();
		for (const backend of this.backends.values()) {
			for (const language of backend.languages) languages.add(language);
		}
		return [...languages].sort();
	}

	list(): LanguageBackend[] {
		return [...this.backends.values()];
	}

	/** Version keys of every backend, merged — feeds the index config hash. */
	versionKeys(): Record<string, string> {
		const merged: Record<string, string> = {
			"extraction:contract": EXTRACTION_CONTRACT_VERSION,
			// Re-categorizing a diagnostic changes what persisted rows mean, so the
			// taxonomy is part of the index identity (AG-201).
			"diagnostics:registry": DIAGNOSTIC_REGISTRY_VERSION,
		};
		for (const backend of this.backends.values()) {
			for (const [key, value] of Object.entries(backend.versionKeys())) {
				merged[`${backend.id}/${key}`] = value;
			}
		}
		return merged;
	}

	summary(): BackendStatus[] {
		const unavailable = unavailableGrammars();
		const loaded = new Set(loadedGrammars());

		return this.list().map((backend): BackendStatus => {
			const needed = grammarsFor(backend);
			return {
				id: backend.id,
				languages: backend.languages,
				extensions: backend.extensions,
				versions: backend.versionKeys(),
				enricher:
					backend.enricher === undefined ? "none" : backend.enricher.mode,
				capabilities: backend.capabilities,
				grammarsLoaded: needed.filter((lang) => loaded.has(lang)).sort(),
				grammarsUnavailable: unavailable
					.filter((entry) => needed.includes(entry.lang))
					.map((entry) => ({ lang: entry.lang, reason: entry.reason })),
			};
		});
	}
}

/**
 * Identity of the extraction contract itself, independent of any one backend.
 * Bump it whenever reconciliation, provenance, or Pass A/Pass B semantics
 * change so pre-existing indexes rebuild instead of mixing row generations.
 */
export const EXTRACTION_CONTRACT_VERSION = "2";

/**
 * Extensions each *shipped* backend claims, enabled or not.
 *
 * `createDefaultRegistry` omits a disabled backend entirely, so from the
 * registry's point of view its files look like an unsupported extension. That
 * distinction matters to the user: "PHP is turned off" is actionable, "nothing
 * reads .php" is not. `shippedBackendExtensionOwners()` restores it.
 *
 * Kept in sync with the backend classes by `registry.test.ts`, which builds the
 * default registry and asserts the table matches.
 */
const SHIPPED_BACKEND_EXTENSIONS: Record<string, readonly string[]> = {
	typescript: [
		".ts",
		".tsx",
		".js",
		".jsx",
		".mts",
		".cts",
		".mjs",
		".cjs",
	],
	php: [".php"],
};

/** Extension → owning shipped backend id, lower-cased, regardless of config. */
export function shippedBackendExtensionOwners(): ReadonlyMap<string, string> {
	const owners = new Map<string, string>();
	for (const [id, extensions] of Object.entries(SHIPPED_BACKEND_EXTENSIONS)) {
		for (const ext of extensions) owners.set(ext.toLowerCase(), id);
	}
	return owners;
}

/** Rejected backend registration: a defect in the backend, not user input. */
export class BackendRegistrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BackendRegistrationError";
	}
}

/** Exhaustive by construction: adding an `EdgeKind` fails to typecheck here. */
const EDGE_KINDS: Record<EdgeKind, true> = {
	contains: true,
	calls: true,
	imports: true,
	exports: true,
	extends: true,
	implements: true,
	references: true,
	type_of: true,
	returns: true,
	instantiates: true,
	overrides: true,
	decorates: true,
};

/**
 * Edge kinds Pass A alone can produce. A backend without an enricher must not
 * advertise more than this: an empty `callers` result under a clean coverage
 * banner would otherwise read as "nothing calls this".
 */
const PASS_A_EDGE_KINDS: readonly EdgeKind[] = ["contains"];

/**
 * Registration-time contract check. Routing, coverage, and capability notes all
 * assume unique ids, one owner per extension, and capabilities that describe
 * what the configured backend can actually emit; a violation is unrecoverable
 * at query time, so it fails here instead.
 */
function validateBackends(backends: LanguageBackend[]): void {
	const seenIds = new Set<string>();
	const extensionOwner = new Map<string, string>();

	for (const backend of backends) {
		if (backend.id.length === 0) {
			throw new BackendRegistrationError("Backend id must not be empty");
		}
		if (seenIds.has(backend.id)) {
			throw new BackendRegistrationError(
				`Duplicate backend id "${backend.id}"`,
			);
		}
		seenIds.add(backend.id);

		if (backend.extensions.length === 0) {
			throw new BackendRegistrationError(
				`Backend "${backend.id}" claims no extensions`,
			);
		}
		for (const rawExt of backend.extensions) {
			const ext = rawExt.toLowerCase();
			if (!ext.startsWith(".") || ext.length < 2) {
				throw new BackendRegistrationError(
					`Backend "${backend.id}" declares invalid extension "${rawExt}"`,
				);
			}
			const owner = extensionOwner.get(ext);
			if (owner !== undefined) {
				throw new BackendRegistrationError(
					`Extension "${ext}" is claimed by both "${owner}" and "${backend.id}"`,
				);
			}
			extensionOwner.set(ext, backend.id);
		}

		validateCapabilities(backend);
	}
}

function validateCapabilities(backend: LanguageBackend): void {
	const declared = backend.capabilities.edgeKinds;
	if (declared.length === 0) {
		throw new BackendRegistrationError(
			`Backend "${backend.id}" declares no edge kinds`,
		);
	}

	const seen = new Set<EdgeKind>();
	for (const kind of declared) {
		if (!(kind in EDGE_KINDS)) {
			throw new BackendRegistrationError(
				`Backend "${backend.id}" declares unknown edge kind "${kind}"`,
			);
		}
		if (seen.has(kind)) {
			throw new BackendRegistrationError(
				`Backend "${backend.id}" declares edge kind "${kind}" twice`,
			);
		}
		seen.add(kind);
	}

	// Pass A always runs, so containment is always producible.
	if (!seen.has("contains")) {
		throw new BackendRegistrationError(
			`Backend "${backend.id}" must declare "contains"; Pass A always runs`,
		);
	}

	if (backend.enricher === undefined) {
		const semantic = declared.filter(
			(kind) => !PASS_A_EDGE_KINDS.includes(kind),
		);
		if (semantic.length > 0) {
			throw new BackendRegistrationError(
				`Pass-A-only backend "${backend.id}" declares enricher-only edge kinds: ${semantic.join(", ")}`,
			);
		}
		return;
	}

	if (backend.enricher.mode !== "complement") {
		throw new BackendRegistrationError(
			`Backend "${backend.id}" declares a non-complement enricher`,
		);
	}
	if (backend.enricher.id.length === 0) {
		throw new BackendRegistrationError(
			`Backend "${backend.id}" has an enricher without an id`,
		);
	}
	if (backend.enricher.provenance.length === 0) {
		throw new BackendRegistrationError(
			`Backend "${backend.id}" has an enricher without a provenance`,
		);
	}
}

/** tree-sitter grammars a backend needs, derived from its own extensions. */
function grammarsFor(backend: LanguageBackend): TreeSitterLang[] {
	const langs = new Set<TreeSitterLang>();
	for (const ext of backend.extensions) {
		const lang = treeSitterLangFromPath(`x${ext}`);
		if (lang) langs.add(lang);
	}
	return [...langs];
}

export interface CreateRegistryOptions {
	hasher: Hasher;
	now?: () => number;
	project?: string;
	config?: AstrographConfig;
}

/** Build the shipped registry after applying per-backend configuration overrides. */
export function createDefaultRegistry(
	opts: CreateRegistryOptions,
): LanguageRegistry {
	const [typescriptBackendId, phpBackendId] = SHIPPED_BACKEND_IDS;
	const overrides = opts.config?.backends ?? {};
	const isEnabled = (id: string): boolean => overrides[id]?.enabled !== false;
	const wantsEnricher = (id: string): boolean =>
		overrides[id]?.enricher !== false;

	const backends: LanguageBackend[] = [];

	if (isEnabled(typescriptBackendId)) {
		backends.push(
			new TypescriptLanguageBackend({
				hasher: opts.hasher,
				now: opts.now,
				project: opts.project,
				enricher: wantsEnricher(typescriptBackendId),
			}),
		);
	}

	if (isEnabled(phpBackendId)) {
		backends.push(
			createPhpBackend({
				hasher: opts.hasher,
				now: opts.now,
				project: opts.project,
				enricher: wantsEnricher(phpBackendId),
			}),
		);
	}

	return new LanguageRegistry(backends);
}

/** tree-sitter grammars every backend in a registry needs, for preloading. */
export function grammarsForRegistry(
	registry: LanguageRegistry,
): TreeSitterLang[] {
	const langs = new Set<TreeSitterLang>();
	for (const backend of registry.list()) {
		for (const lang of grammarsFor(backend)) langs.add(lang);
	}
	return [...langs].sort();
}
