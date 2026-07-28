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
	private readonly extensions: string[];

	constructor(opts: BunGlobScannerOptions = {}) {
		this.extensions = opts.extensions ?? FALLBACK_EXTENSIONS;
		this.defaultInclude = includeGlobFor(this.extensions);
	}

	async *scan(
		root: string,
		opts: { include?: string[]; exclude?: string[]; gitignore?: boolean },
	): AsyncIterable<string> {
		const rootPath = normalizePath(root);
		// TODO(perf): Bun.Glob does not expose directory-pruning hooks; ignored
		// directories are filtered after enumeration for now.
		const hardExclude = ignore().add(ALWAYS_EXCLUDE);
		if (opts.exclude !== undefined && opts.exclude.length > 0) {
			hardExclude.add(opts.exclude);
		}

		const gitignoreMatcher = ignore();
		const useGitignore = opts.gitignore !== false;
		if (useGitignore) {
			const gitignoreFile = Bun.file(`${rootPath}/.gitignore`);
			if (await gitignoreFile.exists()) {
				gitignoreMatcher.add(await gitignoreFile.text());
			}
		}

		// Git's rule: a tracked file is never ignored by .gitignore, even when a
		// whitelist pattern (e.g. Magento's leading `*`) would otherwise drop it.
		// One `git ls-files` beats per-path `git check-ignore` on 3k+ file repos.
		const tracked =
			useGitignore && (await isGitRepo(rootPath))
				? await listTrackedFiles(rootPath)
				: null;

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
				if (hardExclude.ignores(relPath)) continue;
				if (
					useGitignore &&
					gitignoreMatcher.ignores(relPath) &&
					tracked?.has(relPath) !== true
				) {
					continue;
				}
				found.add(relPath);
			}
		}

		// Tracked files that match our include globs but were never yielded above
		// (rare) still join the scan set — same hard excludes still apply.
		if (tracked !== null) {
			const includeGlobs = (opts.include ?? this.defaultInclude).map(
				(pattern) => new Bun.Glob(pattern),
			);
			for (const relPath of tracked) {
				if (found.has(relPath)) continue;
				if (hardExclude.ignores(relPath)) continue;
				if (!matchesAnyGlob(relPath, includeGlobs)) continue;
				found.add(relPath);
			}
		}

		for (const relPath of [...found].sort(compareStrings)) {
			yield relPath;
		}
	}
}

function matchesAnyGlob(relPath: string, globs: Bun.Glob[]): boolean {
	for (const glob of globs) {
		if (glob.match(relPath)) return true;
	}
	return false;
}

async function isGitRepo(rootPath: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(
			["git", "-C", rootPath, "rev-parse", "--is-inside-work-tree"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const exit = await proc.exited;
		if (exit !== 0) return false;
		const text = (await new Response(proc.stdout).text()).trim();
		return text === "true";
	} catch {
		return false;
	}
}

/** Relative paths from `git ls-files`, or null when git is unavailable. */
async function listTrackedFiles(rootPath: string): Promise<Set<string> | null> {
	try {
		const proc = Bun.spawn(["git", "-C", rootPath, "ls-files", "-z"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exit = await proc.exited;
		if (exit !== 0) return null;
		const text = await new Response(proc.stdout).text();
		const tracked = new Set<string>();
		for (const entry of text.split("\0")) {
			if (entry === "") continue;
			tracked.add(normalizePath(entry));
		}
		return tracked;
	} catch {
		return null;
	}
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
