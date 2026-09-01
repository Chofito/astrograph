import type {
	ConfigDiagnostic,
	NormalizedAstrographConfig,
} from "../src/config";

export interface ValidConfigurationFixture {
	name: string;
	input: unknown;
	config: NormalizedAstrographConfig;
}

export interface InvalidConfigurationFixture {
	name: string;
	input: unknown;
	diagnostics: ConfigDiagnostic[];
}

export const VALID_CONFIGURATION_FIXTURES: ValidConfigurationFixture[] = [
	{
		name: "applies canonical defaults",
		input: {},
		config: {
			include: undefined,
			exclude: [],
			maxFileSizeBytes: 2_000_000,
			watchDebounceMs: 300,
			tsconfigPath: undefined,
			backends: {
				php: { enabled: true, enricher: true },
				typescript: { enabled: true, enricher: true },
			},
		},
	},
	{
		name: "normalizes semantic values",
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
		config: {
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
];

export const INVALID_CONFIGURATION_FIXTURES: InvalidConfigurationFixture[] = [
	{
		name: "rejects the removed kinds field",
		input: { kinds: ["function"] },
		diagnostics: [
			{
				code: "UNKNOWN_CONFIG_KEY",
				path: "/kinds",
				message:
					'Unknown configuration key "kinds"; kinds filters were removed and are not supported.',
			},
		],
	},
	{
		name: "rejects an invalid semantic field",
		input: { maxFileSizeBytes: 0 },
		diagnostics: [
			{
				code: "CONFIG_MAX_FILE_SIZE_BYTES_INVALID",
				path: "/maxFileSizeBytes",
				message:
					"maxFileSizeBytes must be a safe integer between 1 and 1073741824.",
			},
		],
	},
	{
		name: "rejects an unknown backend",
		input: { backends: { rust: { enabled: true } } },
		diagnostics: [
			{
				code: "UNKNOWN_BACKEND_ID",
				path: "/backends/rust",
				message: 'Unknown backend ID "rust".',
			},
		],
	},
];
