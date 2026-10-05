import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";
import { type Config, DEFAULT_EXCLUDES } from "./config";
import { type Lang, langForPath } from "./parser";

export interface ScannedFile {
	path: string;
	lang: Lang;
	size: number;
	mtime: number;
}

/**
 * Lists indexable files under `root`. Inside a git work tree, git decides what
 * is ignored (nested .gitignore, global excludes); elsewhere the root
 * .gitignore is applied by hand.
 */
export function scanFiles(root: string, config: Config): ScannedFile[] {
	const filter = ignore().add(DEFAULT_EXCLUDES).add(config.exclude);
	const candidates = gitFiles(root) ?? walk(root, filter);
	const files: ScannedFile[] = [];
	for (const path of candidates) {
		const lang = langForPath(path);
		if (!lang || filter.ignores(path)) continue;
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(join(root, path));
		} catch {
			continue; // deleted but still in the git index
		}
		if (!stat.isFile() || stat.size > config.maxFileSize) continue;
		files.push({ path, lang, size: stat.size, mtime: stat.mtimeMs });
	}
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function gitFiles(root: string): string[] | undefined {
	const result = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		stdout: "pipe",
		stderr: "ignore",
	});
	if (result.exitCode !== 0) return undefined;
	return result.stdout.toString().split("\0").filter(Boolean);
}

function walk(root: string, filter: Ignore): string[] {
	const gitignore = join(root, ".gitignore");
	if (existsSync(gitignore)) filter.add(readFileSync(gitignore, "utf8"));
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			const abs = join(dir, entry.name);
			const rel = relative(root, abs);
			if (entry.isDirectory()) {
				if (!filter.ignores(`${rel}/`)) stack.push(abs);
			} else if (entry.isFile()) {
				out.push(rel);
			}
		}
	}
	return out;
}
