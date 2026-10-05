import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, posix } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string[]> = {
	".js": [".ts", ".tsx"],
	".jsx": [".tsx"],
	".mjs": [".mts"],
	".cjs": [".cts"],
};

interface PathsConfig {
	/** Directory (relative to root) that `paths` targets are resolved against. */
	pathsBase: string;
	baseUrl: string | undefined;
	paths: [pattern: string, targets: string[]][];
}

interface WorkspacePackage {
	dir: string;
	entries: string[];
}

/**
 * Maps JS/TS import specifiers to indexed files. Everything resolves against
 * the set of indexed paths, so a miss means "outside the project" (external).
 */
export class ModuleResolver {
	private readonly configByDir = new Map<string, PathsConfig | null>();
	private readonly packages = new Map<string, WorkspacePackage>();
	private readonly visitedDirs = new Set<string>();

	constructor(
		private readonly root: string,
		private readonly files: Set<string>,
	) {
		for (const file of files) this.discoverPackages(posix.dirname(file));
	}

	resolve(fromFile: string, specifier: string): string | undefined {
		if (specifier.startsWith(".") || specifier.startsWith("/")) {
			const base = specifier.startsWith("/") ? specifier.slice(1) : posix.join(posix.dirname(fromFile), specifier);
			return this.tryFile(base);
		}

		const config = this.configFor(posix.dirname(fromFile));
		if (config) {
			for (const [pattern, targets] of config.paths) {
				const match = matchPattern(pattern, specifier);
				if (match === undefined) continue;
				for (const target of targets) {
					const hit = this.tryFile(posix.join(config.pathsBase, target.replace("*", match)));
					if (hit) return hit;
				}
			}
			if (config.baseUrl !== undefined) {
				const hit = this.tryFile(posix.join(config.baseUrl, specifier));
				if (hit) return hit;
			}
		}

		return this.resolvePackage(specifier);
	}

	private tryFile(path: string): string | undefined {
		const base = posix.normalize(path).replace(/\/$/, "");
		if (base.startsWith("..")) return undefined;
		if (this.files.has(base)) return base;
		const ext = posix.extname(base);
		for (const swap of JS_TO_TS[ext] ?? []) {
			const candidate = base.slice(0, -ext.length) + swap;
			if (this.files.has(candidate)) return candidate;
		}
		for (const suffix of EXTENSIONS) {
			if (this.files.has(base + suffix)) return base + suffix;
		}
		for (const suffix of EXTENSIONS) {
			const candidate = base === "." ? `index${suffix}` : `${base}/index${suffix}`;
			if (this.files.has(candidate)) return candidate;
		}
		return undefined;
	}

	private resolvePackage(specifier: string): string | undefined {
		const parts = specifier.split("/");
		const nameLength = specifier.startsWith("@") ? 2 : 1;
		const name = parts.slice(0, nameLength).join("/");
		const subpath = parts.slice(nameLength).join("/");
		const pkg = this.packages.get(name);
		if (!pkg) return undefined;
		if (subpath) {
			return this.tryFile(posix.join(pkg.dir, subpath)) ?? this.tryFile(posix.join(pkg.dir, "src", subpath));
		}
		for (const entry of pkg.entries) {
			const hit = this.tryFile(posix.join(pkg.dir, entry));
			if (hit) return hit;
		}
		return this.tryFile(posix.join(pkg.dir, "src/index")) ?? this.tryFile(posix.join(pkg.dir, "index"));
	}

	/** Records every package.json between indexed files and the root. */
	private discoverPackages(dir: string) {
		let current = dir;
		while (!this.visitedDirs.has(current)) {
			this.visitedDirs.add(current);
			const manifest = readJson(join(this.root, current, "package.json"));
			const name = manifest?.name;
			if (manifest && typeof name === "string" && !this.packages.has(name)) {
				this.packages.set(name, { dir: current, entries: packageEntries(manifest) });
			}
			if (current === ".") break;
			current = posix.dirname(current);
		}
	}

	/** Nearest tsconfig.json / jsconfig.json at or above `dir`. */
	private configFor(dir: string): PathsConfig | null {
		const cached = this.configByDir.get(dir);
		if (cached !== undefined) return cached;
		let config: PathsConfig | null = null;
		for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
			const abs = join(this.root, dir, fileName);
			if (existsSync(abs)) {
				config = loadPathsConfig(this.root, abs);
				break;
			}
		}
		if (config === null && dir !== ".") config = this.configFor(posix.dirname(dir));
		this.configByDir.set(dir, config);
		return config;
	}
}

function loadPathsConfig(root: string, absPath: string, depth = 0): PathsConfig | null {
	const json = readJson(absPath);
	if (!json || depth > 5) return null;
	const configDir = dirname(absPath);
	let inherited: PathsConfig | null = null;
	const parents = Array.isArray(json.extends) ? json.extends : [json.extends];
	for (const parent of parents) {
		if (typeof parent !== "string" || !parent.startsWith(".")) continue;
		const parentPath = normalize(join(configDir, parent.endsWith(".json") ? parent : `${parent}.json`));
		inherited = loadPathsConfig(root, parentPath, depth + 1) ?? inherited;
	}

	const options = (json.compilerOptions ?? {}) as Record<string, unknown>;
	const rel = (abs: string) => toRootRelative(root, abs);
	const baseUrl = typeof options.baseUrl === "string" ? rel(join(configDir, options.baseUrl)) : inherited?.baseUrl;
	let paths = inherited?.paths ?? [];
	let pathsBase = inherited?.pathsBase ?? rel(configDir);
	if (options.paths && typeof options.paths === "object") {
		paths = Object.entries(options.paths as Record<string, unknown>).map(([pattern, targets]) => [
			pattern,
			Array.isArray(targets) ? targets.filter((t): t is string => typeof t === "string") : [],
		]);
		pathsBase = baseUrl ?? rel(configDir);
	}
	if (baseUrl === undefined && paths.length === 0) return null;
	return { pathsBase, baseUrl, paths };
}

function packageEntries(manifest: Record<string, unknown>): string[] {
	const entries: string[] = [];
	const exportsField = manifest.exports;
	const dot =
		typeof exportsField === "object" && exportsField !== null && "." in exportsField
			? (exportsField as Record<string, unknown>)["."]
			: exportsField;
	collectStrings(dot, entries);
	for (const field of ["source", "module", "main", "types"]) {
		const value = manifest[field];
		if (typeof value === "string") entries.push(value);
	}
	return entries;
}

function collectStrings(value: unknown, into: string[]) {
	if (typeof value === "string") into.push(value);
	else if (typeof value === "object" && value !== null) {
		for (const nested of Object.values(value)) collectStrings(nested, into);
	}
}

function matchPattern(pattern: string, specifier: string): string | undefined {
	const star = pattern.indexOf("*");
	if (star === -1) return pattern === specifier ? "" : undefined;
	const prefix = pattern.slice(0, star);
	const suffix = pattern.slice(star + 1);
	if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
	if (specifier.length < prefix.length + suffix.length) return undefined;
	return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function toRootRelative(root: string, abs: string): string {
	const rel = posix.relative(root, abs);
	return rel === "" ? "." : rel;
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const value = parseJsonc(readFileSync(path, "utf8"));
		return typeof value === "object" && value !== null ? value : undefined;
	} catch {
		return undefined;
	}
}
