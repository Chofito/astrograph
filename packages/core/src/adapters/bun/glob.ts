import ignore from "ignore";
import type { GlobScanner } from "../../types";

/**
 * Fallback only. The real list comes from the language registry — see
 * `BunGlobScanner`'s `extensions` option — so a new backend widens the scan
 * without anyone editing this file.
 */
const FALLBACK_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
];

function includeGlobFor(extensions: string[]): string[] {
	const suffixes = [
		...new Set(
			extensions.map((ext) => (ext.startsWith(".") ? ext.slice(1) : ext)),
		),
	]
		.filter((suffix) => suffix.length > 0)
		.sort();
	if (suffixes.length === 0) return [];
	if (suffixes.length === 1) return [`**/*.${suffixes[0]}`];
	return [`**/*.{${suffixes.join(",")}}`];
}
const ALWAYS_EXCLUDE = [
	// VCS / tooling internals
	"node_modules/",
	".git/",
	".astrograph/",
	// Build / output directories
	"dist/",
	"build/",
	"out/",
	"output/",
	".next/",
	".nuxt/",
	".svelte-kit/",
	".turbo/",
	".cache/",
	"coverage/",
	// Yarn / pnpm committed artifacts — these are versioned (so .gitignore
	// does not catch them) yet match the *.cjs/*.mjs include glob.
	".yarn/",
	".pnp.cjs",
	".pnp.loader.mjs",
	".pnpm/",
];

export interface BunGlobScannerOptions {
	/** Extensions the language registry knows how to parse, e.g. `[".ts", ".php"]`. */
	extensions?: string[];
}

export class BunGlobScanner implements GlobScanner {
	private readonly defaultInclude: string[];

	constructor(opts: BunGlobScannerOptions = {}) {
		this.defaultInclude = includeGlobFor(
			opts.extensions ?? FALLBACK_EXTENSIONS,
		);
	}

	async *scan(
		root: string,
		opts: { include?: string[]; exclude?: string[]; gitignore?: boolean },
	): AsyncIterable<string> {
		const rootPath = normalizePath(root);
		// TODO(perf): Bun.Glob does not expose directory-pruning hooks; ignored
		// directories are filtered after enumeration for now.
		const matcher = ignore().add(ALWAYS_EXCLUDE);

		if (opts.gitignore !== false) {
			const gitignoreFile = Bun.file(`${rootPath}/.gitignore`);
			if (await gitignoreFile.exists()) {
				matcher.add(await gitignoreFile.text());
			}
		}

		if (opts.exclude !== undefined && opts.exclude.length > 0) {
			matcher.add(opts.exclude);
		}

		const found = new Set<string>();
		for (const pattern of opts.include ?? this.defaultInclude) {
			const glob = new Bun.Glob(pattern);
			for await (const path of glob.scan({
				cwd: rootPath,
				absolute: false,
				dot: true,
				onlyFiles: true,
			})) {
				const relPath = normalizePath(path);
				if (matcher.ignores(relPath)) continue;
				found.add(relPath);
			}
		}

		for (const relPath of [...found].sort(compareStrings)) {
			yield relPath;
		}
	}
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
