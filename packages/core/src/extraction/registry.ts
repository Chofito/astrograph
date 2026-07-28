import type {
	AstrographConfig,
	BackendStatus,
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

export class LanguageRegistry {
	private readonly backends: Map<string, LanguageBackend> = new Map();
	private readonly extensionToBackend: Map<string, LanguageBackend> = new Map();

	constructor(backends: LanguageBackend[]) {
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
		const merged: Record<string, string> = {};
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
				enricher: backend.enricher?.mode ?? "none",
				capabilities: backend.capabilities,
				grammarsLoaded: needed.filter((lang) => loaded.has(lang)).sort(),
				grammarsUnavailable: unavailable
					.filter((entry) => needed.includes(entry.lang))
					.map((entry) => ({ lang: entry.lang, reason: entry.reason })),
			};
		});
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

export function createDefaultRegistry(
	opts: CreateRegistryOptions,
): LanguageRegistry {
	const overrides = opts.config?.backends ?? {};
	const isEnabled = (id: string): boolean => overrides[id]?.enabled !== false;
	const wantsEnricher = (id: string): boolean =>
		overrides[id]?.enricher !== false;

	const backends: LanguageBackend[] = [];

	if (isEnabled("typescript")) {
		backends.push(
			new TypescriptLanguageBackend({
				hasher: opts.hasher,
				now: opts.now,
				project: opts.project,
				enricher: wantsEnricher("typescript"),
			}),
		);
	}

	if (isEnabled("php")) {
		backends.push(
			createPhpBackend({
				hasher: opts.hasher,
				now: opts.now,
				project: opts.project,
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
