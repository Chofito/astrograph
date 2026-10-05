import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const INDEX_DIR = ".astrograph";

export interface Config {
	/** Extra gitignore-style patterns to skip, on top of .gitignore and the defaults. */
	exclude: string[];
	/** Files larger than this are skipped (generated bundles, fixtures). */
	maxFileSize: number;
}

export const DEFAULT_EXCLUDES = [
	"node_modules/",
	"vendor/",
	"dist/",
	"build/",
	"out/",
	"coverage/",
	".next/",
	".nuxt/",
	".svelte-kit/",
	`${INDEX_DIR}/`,
	"*.min.js",
	"*.bundle.js",
];

export function loadConfig(root: string): Config {
	const config: Config = { exclude: [], maxFileSize: 512_000 };
	const path = join(root, INDEX_DIR, "config.json");
	if (!existsSync(path)) return config;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`invalid ${path}: ${(error as Error).message}`);
	}
	if (typeof raw !== "object" || raw === null) return config;
	const { exclude, maxFileSize } = raw as Record<string, unknown>;
	if (Array.isArray(exclude)) config.exclude = exclude.filter((p) => typeof p === "string");
	if (typeof maxFileSize === "number" && maxFileSize > 0) config.maxFileSize = maxFileSize;
	return config;
}
