/**
 * Runtime-free project configuration parsing and normalization.
 *
 * This module deliberately has no filesystem, registry construction, or Bun
 * dependency. Callers discover their available backend IDs, then pass them to
 * the parser before opening a project.
 */

export interface AstrographConfig {
	include?: string[];
	exclude?: string[];
	maxFileSizeBytes?: number;
	watchDebounceMs?: number;
	tsconfigPath?: string;
	/** Per-backend switches keyed by a registered `LanguageBackend.id`. */
	backends?: Record<string, BackendConfig>;
}

export interface BackendConfig {
	enabled?: boolean;
	enricher?: boolean;
}

export interface NormalizedBackendConfig {
	enabled: boolean;
	enricher: boolean;
}

/** The canonical runtime configuration after defaults and input normalization. */
export interface NormalizedAstrographConfig {
	/** `undefined` means every file type claimed by an enabled backend. */
	include: string[] | undefined;
	exclude: string[];
	maxFileSizeBytes: number;
	watchDebounceMs: number;
	/** `undefined` delegates TS config discovery to the TypeScript backend. */
	tsconfigPath: string | undefined;
	backends: Record<string, NormalizedBackendConfig>;
}

export interface ConfigDiagnostic {
	/** Stable machine-readable failure code. */
	code: ConfigDiagnosticCode;
	/** RFC 6901 JSON Pointer; the root document is `""`. */
	path: string;
	message: string;
}

export type ConfigDiagnosticCode =
	| "CONFIG_ROOT_NOT_OBJECT"
	| "UNKNOWN_CONFIG_KEY"
	| "CONFIG_GLOB_LIST_TYPE"
	| "CONFIG_GLOB_TYPE"
	| "CONFIG_GLOB_EMPTY"
	| "CONFIG_GLOB_NOT_PROJECT_RELATIVE"
	| "CONFIG_MAX_FILE_SIZE_BYTES_INVALID"
	| "CONFIG_WATCH_DEBOUNCE_MS_INVALID"
	| "CONFIG_TSCONFIG_PATH_TYPE"
	| "CONFIG_TSCONFIG_PATH_EMPTY"
	| "CONFIG_TSCONFIG_PATH_NOT_PROJECT_RELATIVE"
	| "CONFIG_BACKENDS_NOT_OBJECT"
	| "UNKNOWN_BACKEND_ID"
	| "CONFIG_BACKEND_NOT_OBJECT"
	| "UNKNOWN_BACKEND_KEY"
	| "CONFIG_BACKEND_BOOLEAN_INVALID";

export type ConfigParseResult =
	| { ok: true; config: NormalizedAstrographConfig; diagnostics: [] }
	| { ok: false; diagnostics: ConfigDiagnostic[] };

export interface ParseAstrographConfigOptions {
	knownBackendIds: readonly string[];
}

/** Backend IDs shipped by the default registry; external plugins are not configurable. */
export const SHIPPED_BACKEND_IDS = ["typescript", "php"] as const;

/** Limits are public so documentation and surfaces can format the same contract. */
export const ASTROGRAPH_CONFIG_LIMITS = Object.freeze({
	maxFileSizeBytes: Object.freeze({ min: 1, max: 1_073_741_824 }),
	watchDebounceMs: Object.freeze({ min: 0, max: 60_000 }),
});

/** Defaults are defined here once; callers receive cloned collection values. */
export const DEFAULT_ASTROGRAPH_CONFIG = Object.freeze({
	include: undefined,
	exclude: Object.freeze([]) as readonly string[],
	maxFileSizeBytes: 2_000_000,
	watchDebounceMs: 300,
	tsconfigPath: undefined,
});

const CONFIG_KEYS = [
	"include",
	"exclude",
	"maxFileSizeBytes",
	"watchDebounceMs",
	"tsconfigPath",
	"backends",
] as const;
const BACKEND_KEYS = ["enabled", "enricher"] as const;

/**
 * Validate user-controlled JSON and return its canonical configuration or all
 * stable, field-addressable diagnostics. This function is side-effect free.
 */
export function parseAstrographConfig(
	input: unknown,
	options: ParseAstrographConfigOptions,
): ConfigParseResult {
	if (!isJsonObject(input)) {
		return {
			ok: false,
			diagnostics: [
				diagnostic(
					"CONFIG_ROOT_NOT_OBJECT",
					"",
					"Configuration must be a JSON object.",
				),
			],
		};
	}

	const diagnostics: ConfigDiagnostic[] = [];
	for (const key of Object.keys(input).sort(compareStrings)) {
		if (!isConfigKey(key)) {
			const message =
				key === "kinds"
					? 'Unknown configuration key "kinds"; kinds filters were removed and are not supported.'
					: `Unknown configuration key "${key}".`;
			diagnostics.push(diagnostic("UNKNOWN_CONFIG_KEY", pointer(key), message));
		}
	}

	const include = parseGlobList(input.include, "/include", diagnostics);
	const exclude = parseGlobList(input.exclude, "/exclude", diagnostics);
	const maxFileSizeBytes = parseBoundedInteger(
		input.maxFileSizeBytes,
		"/maxFileSizeBytes",
		"CONFIG_MAX_FILE_SIZE_BYTES_INVALID",
		"maxFileSizeBytes",
		ASTROGRAPH_CONFIG_LIMITS.maxFileSizeBytes,
		diagnostics,
	);
	const watchDebounceMs = parseBoundedInteger(
		input.watchDebounceMs,
		"/watchDebounceMs",
		"CONFIG_WATCH_DEBOUNCE_MS_INVALID",
		"watchDebounceMs",
		ASTROGRAPH_CONFIG_LIMITS.watchDebounceMs,
		diagnostics,
	);
	const tsconfigPath = parseTsconfigPath(input.tsconfigPath, diagnostics);
	const backends = parseBackends(input.backends, options.knownBackendIds, diagnostics);

	if (diagnostics.length > 0) return { ok: false, diagnostics };

	return {
		ok: true,
		config: normalizeAstrographConfig(
			{
				include,
				exclude,
				maxFileSizeBytes,
				watchDebounceMs,
				tsconfigPath,
				backends,
			},
			options,
		),
		diagnostics: [],
	};
}

/**
 * Apply the same defaults and canonical ordering to trusted programmatic
 * configuration. Transport boundaries must use `parseAstrographConfig` first.
 */
export function normalizeAstrographConfig(
	config: AstrographConfig = {},
	options: ParseAstrographConfigOptions = { knownBackendIds: [] },
): NormalizedAstrographConfig {
	const knownBackendIds = uniqueSorted([
		...options.knownBackendIds,
		...Object.keys(config.backends ?? {}),
	]);
	const backends: Record<string, NormalizedBackendConfig> = {};
	for (const id of knownBackendIds) {
		const override = config.backends?.[id];
		backends[id] = {
			enabled: override?.enabled ?? true,
			enricher: override?.enricher ?? true,
		};
	}

	return {
		include:
			config.include === undefined ? undefined : normalizeStringList(config.include),
		exclude:
			config.exclude === undefined
				? [...DEFAULT_ASTROGRAPH_CONFIG.exclude]
				: normalizeStringList(config.exclude),
		maxFileSizeBytes:
			config.maxFileSizeBytes ?? DEFAULT_ASTROGRAPH_CONFIG.maxFileSizeBytes,
		watchDebounceMs:
			config.watchDebounceMs ?? DEFAULT_ASTROGRAPH_CONFIG.watchDebounceMs,
		tsconfigPath:
			config.tsconfigPath === undefined
				? DEFAULT_ASTROGRAPH_CONFIG.tsconfigPath
				: normalizeProjectRelative(config.tsconfigPath),
		backends,
	};
}

/**
 * Extraction inputs only. Operational debounce is intentionally excluded so a
 * scheduling change cannot alter graph identity or trigger a semantic rebuild.
 */
export function semanticAstrographConfig(
	config: NormalizedAstrographConfig,
): {
	include: string[] | null;
	exclude: string[];
	maxFileSizeBytes: number;
	tsconfigPath: string | null;
	backends: Record<string, NormalizedBackendConfig>;
} {
	return {
		include: config.include === undefined ? null : [...config.include],
		exclude: [...config.exclude],
		maxFileSizeBytes: config.maxFileSizeBytes,
		tsconfigPath: config.tsconfigPath ?? null,
		backends: Object.fromEntries(
			Object.entries(config.backends)
				.sort(([left], [right]) => compareStrings(left, right))
				.map(([id, backend]) => [id, { ...backend }]),
		),
	};
}

function parseGlobList(
	value: unknown,
	path: string,
	diagnostics: ConfigDiagnostic[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		diagnostics.push(
			diagnostic(
				"CONFIG_GLOB_LIST_TYPE",
				path,
				"Expected an array of relative glob strings.",
			),
		);
		return undefined;
	}

	const values: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const entry = value[index];
		const entryPath = `${path}/${index}`;
		if (typeof entry !== "string") {
			diagnostics.push(diagnostic("CONFIG_GLOB_TYPE", entryPath, "Expected a string."));
			continue;
		}
		if (entry.trim().length === 0) {
			diagnostics.push(
				diagnostic("CONFIG_GLOB_EMPTY", entryPath, "Glob must not be empty."),
			);
			continue;
		}
		if (!isProjectRelative(entry)) {
			diagnostics.push(
				diagnostic(
					"CONFIG_GLOB_NOT_PROJECT_RELATIVE",
					entryPath,
					"Glob must be project-relative and must not traverse above the project root.",
				),
			);
			continue;
		}
		values.push(normalizeProjectRelative(entry));
	}
	return normalizeStringList(values);
}

function parseBoundedInteger(
	value: unknown,
	path: string,
	code:
		| "CONFIG_MAX_FILE_SIZE_BYTES_INVALID"
		| "CONFIG_WATCH_DEBOUNCE_MS_INVALID",
	name: string,
	limits: { min: number; max: number },
	diagnostics: ConfigDiagnostic[],
): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < limits.min ||
		value > limits.max
	) {
		diagnostics.push(
			diagnostic(
				code,
				path,
				`${name} must be a safe integer between ${limits.min} and ${limits.max}.`,
			),
		);
		return undefined;
	}
	return value;
}

function parseTsconfigPath(
	value: unknown,
	diagnostics: ConfigDiagnostic[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			diagnostic(
				"CONFIG_TSCONFIG_PATH_TYPE",
				"/tsconfigPath",
				"tsconfigPath must be a project-relative string.",
			),
		);
		return undefined;
	}
	if (value.trim().length === 0) {
		diagnostics.push(
			diagnostic(
				"CONFIG_TSCONFIG_PATH_EMPTY",
				"/tsconfigPath",
				"tsconfigPath must not be empty.",
			),
		);
		return undefined;
	}
	if (!isProjectRelative(value)) {
		diagnostics.push(
			diagnostic(
				"CONFIG_TSCONFIG_PATH_NOT_PROJECT_RELATIVE",
				"/tsconfigPath",
				"tsconfigPath must be project-relative and must not traverse above the project root.",
			),
		);
		return undefined;
	}
	return normalizeProjectRelative(value);
}

function parseBackends(
	value: unknown,
	knownBackendIds: readonly string[],
	diagnostics: ConfigDiagnostic[],
): Record<string, BackendConfig> | undefined {
	if (value === undefined) return undefined;
	if (!isJsonObject(value)) {
		diagnostics.push(
			diagnostic(
				"CONFIG_BACKENDS_NOT_OBJECT",
				"/backends",
				"backends must be an object keyed by known backend IDs.",
			),
		);
		return undefined;
	}

	const known = new Set(knownBackendIds);
	const parsed: Record<string, BackendConfig> = {};
	for (const id of Object.keys(value).sort(compareStrings)) {
		const backendPath = pointer("backends", id);
		if (!known.has(id)) {
			diagnostics.push(
				diagnostic(
					"UNKNOWN_BACKEND_ID",
					backendPath,
					`Unknown backend ID "${id}".`,
				),
			);
			continue;
		}

		const backend = value[id];
		if (!isJsonObject(backend)) {
			diagnostics.push(
				diagnostic(
					"CONFIG_BACKEND_NOT_OBJECT",
					backendPath,
					"Backend configuration must be an object.",
				),
			);
			continue;
		}

		for (const key of Object.keys(backend).sort(compareStrings)) {
			const keyPath = pointer("backends", id, key);
			if (!isBackendKey(key)) {
				diagnostics.push(
					diagnostic(
						"UNKNOWN_BACKEND_KEY",
						keyPath,
						`Unknown backend configuration key "${key}".`,
					),
				);
				continue;
			}
			if (typeof backend[key] !== "boolean") {
				diagnostics.push(
					diagnostic(
						"CONFIG_BACKEND_BOOLEAN_INVALID",
						keyPath,
						`${key} must be a boolean.`,
					),
				);
			}
		}

		parsed[id] = {
			enabled: backend.enabled as boolean | undefined,
			enricher: backend.enricher as boolean | undefined,
		};
	}
	return parsed;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isConfigKey(key: string): key is (typeof CONFIG_KEYS)[number] {
	return (CONFIG_KEYS as readonly string[]).includes(key);
}

function isBackendKey(key: string): key is (typeof BACKEND_KEYS)[number] {
	return (BACKEND_KEYS as readonly string[]).includes(key);
}

function isProjectRelative(value: string): boolean {
	const normalized = value.trim().replaceAll("\\", "/");
	if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
		return false;
	}
	return !normalized.split("/").includes("..");
}

function normalizeProjectRelative(value: string): string {
	return value.trim().replaceAll("\\", "/");
}

function normalizeStringList(values: readonly string[]): string[] {
	return uniqueSorted(values.map(normalizeProjectRelative));
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function pointer(...segments: string[]): string {
	return `/${segments.map(escapePointerSegment).join("/")}`;
}

function escapePointerSegment(segment: string): string {
	return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function diagnostic(
	code: ConfigDiagnosticCode,
	path: string,
	message: string,
): ConfigDiagnostic {
	return { code, path, message };
}
