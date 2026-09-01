import { describe, expect, test } from "bun:test";
import {
	type ConfigDiagnostic,
	type NormalizedAstrographConfig,
	parseAstrographConfig,
	semanticAstrographConfig,
} from "./config";

const options = { knownBackendIds: ["typescript", "php"] } as const;

const defaults: NormalizedAstrographConfig = {
	include: undefined,
	exclude: [],
	maxFileSizeBytes: 2_000_000,
	watchDebounceMs: 300,
	tsconfigPath: undefined,
	backends: {
		php: { enabled: true, enricher: true },
		typescript: { enabled: true, enricher: true },
	},
};

interface ParseCase {
	name: string;
	input: unknown;
	expected: NormalizedAstrographConfig;
}

describe("parseAstrographConfig", () => {
	// Annotated: `test.each` infers its rows as const, which makes the literal
	// arrays `readonly` and no longer assignable to the mutable normalized shape.
	test.each<ParseCase>([
		{
			name: "accepts an empty object and applies every default",
			input: {},
			expected: defaults,
		},
		{
			name: "normalizes lists, relative separators, and backend defaults",
			input: {
				include: ["src\\**\\*.ts", "src/**/*.ts"],
				exclude: ["dist", "build", "dist"],
				maxFileSizeBytes: 512,
				watchDebounceMs: 0,
				tsconfigPath: "configs\\tsconfig.app.json",
				backends: {
					typescript: { enricher: false },
					php: { enabled: false },
				},
			},
			expected: {
				include: ["src/**/*.ts"],
				exclude: ["build", "dist"],
				maxFileSizeBytes: 512,
				watchDebounceMs: 0,
				tsconfigPath: "configs/tsconfig.app.json",
				backends: {
					php: { enabled: false, enricher: true },
					typescript: { enabled: true, enricher: false },
				},
			},
		},
	])("$name", ({ input, expected }) => {
		const result = parseAstrographConfig(input, options);
		expect(result).toEqual({ ok: true, config: expected, diagnostics: [] });
	});

	test.each([
		{
			name: "rejects a non-object root",
			input: [],
			diagnostic: diagnostic(
				"CONFIG_ROOT_NOT_OBJECT",
				"",
				"Configuration must be a JSON object.",
			),
		},
		{
			name: "rejects the removed kinds field without silent compatibility",
			input: { kinds: ["function"] },
			diagnostic: diagnostic(
				"UNKNOWN_CONFIG_KEY",
				"/kinds",
				'Unknown configuration key "kinds"; kinds filters were removed and are not supported.',
			),
		},
		{
			name: "rejects a non-array exclude value",
			input: { exclude: "dist" },
			diagnostic: diagnostic(
				"CONFIG_GLOB_LIST_TYPE",
				"/exclude",
				"Expected an array of relative glob strings.",
			),
		},
		{
			name: "rejects a non-relative include glob",
			input: { include: ["../private/**/*.ts"] },
			diagnostic: diagnostic(
				"CONFIG_GLOB_NOT_PROJECT_RELATIVE",
				"/include/0",
				"Glob must be project-relative and must not traverse above the project root.",
			),
		},
		{
			name: "rejects an out-of-range max file size",
			input: { maxFileSizeBytes: 0 },
			diagnostic: diagnostic(
				"CONFIG_MAX_FILE_SIZE_BYTES_INVALID",
				"/maxFileSizeBytes",
				"maxFileSizeBytes must be a safe integer between 1 and 1073741824.",
			),
		},
		{
			name: "rejects an invalid debounce",
			input: { watchDebounceMs: -1 },
			diagnostic: diagnostic(
				"CONFIG_WATCH_DEBOUNCE_MS_INVALID",
				"/watchDebounceMs",
				"watchDebounceMs must be a safe integer between 0 and 60000.",
			),
		},
		{
			name: "rejects a tsconfig path outside the project",
			input: { tsconfigPath: "../tsconfig.json" },
			diagnostic: diagnostic(
				"CONFIG_TSCONFIG_PATH_NOT_PROJECT_RELATIVE",
				"/tsconfigPath",
				"tsconfigPath must be project-relative and must not traverse above the project root.",
			),
		},
		{
			name: "rejects unknown backend IDs",
			input: { backends: { rust: { enabled: true } } },
			diagnostic: diagnostic(
				"UNKNOWN_BACKEND_ID",
				"/backends/rust",
				'Unknown backend ID "rust".',
			),
		},
		{
			name: "rejects unknown backend override keys",
			input: { backends: { php: { cache: true } } },
			diagnostic: diagnostic(
				"UNKNOWN_BACKEND_KEY",
				"/backends/php/cache",
				'Unknown backend configuration key "cache".',
			),
		},
		{
			name: "rejects non-boolean backend switches",
			input: { backends: { php: { enabled: "yes" } } },
			diagnostic: diagnostic(
				"CONFIG_BACKEND_BOOLEAN_INVALID",
				"/backends/php/enabled",
				"enabled must be a boolean.",
			),
		},
	])("$name", ({ input, diagnostic: expectedDiagnostic }) => {
		const result = parseAstrographConfig(input, options);
		expect(result).toEqual({ ok: false, diagnostics: [expectedDiagnostic] });
	});

	test("canonicalizes semantic configuration and excludes operational debounce", () => {
		const first = parseAstrographConfig(
			{
				backends: { typescript: { enricher: false }, php: { enabled: true } },
				exclude: ["dist", "build"],
				include: ["src/**/*.ts", "src/**/*.tsx"],
				watchDebounceMs: 1,
			},
			options,
		);
		const second = parseAstrographConfig(
			{
				watchDebounceMs: 60_000,
				include: ["src/**/*.tsx", "src/**/*.ts"],
				exclude: ["build", "dist"],
				backends: { php: { enabled: true }, typescript: { enricher: false } },
			},
			options,
		);

		if (!first.ok || !second.ok)
			throw new Error("expected valid test fixtures");
		expect(semanticAstrographConfig(first.config)).toEqual(
			semanticAstrographConfig(second.config),
		);
	});
});

function diagnostic(
	code: ConfigDiagnostic["code"],
	path: string,
	message: string,
): ConfigDiagnostic {
	return { code, path, message };
}
