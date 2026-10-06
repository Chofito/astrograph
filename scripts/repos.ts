/**
 * Reference repositories for the eval (and the bench), pinned to a commit.
 *
 *   eval/repos/<name>.json   public: { url, commit, stack, tasks }   committed
 *   eval/local/<name>.json   private: { path, commit, stack, tasks }  gitignored
 *
 * A private entry whose `path` does not exist on this machine is skipped, so
 * anyone can run the public set. Each repository is materialized as a fresh
 * checkout of its commit under the cache directory: working copies are never
 * touched, and uncommitted changes in them are ignored.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Task {
	id: string;
	prompt: string;
	/** Facts a correct answer names: each entry is a string or a list of alternatives. */
	expect: (string | string[])[];
}

export interface Repo {
	name: string;
	stack: string;
	commit: string;
	url?: string;
	path?: string;
	private: boolean;
	tasks: Task[];
}

const ROOT = join(import.meta.dir, "..", "eval");
export const CACHE = process.env.ASTROGRAPH_EVAL_CACHE ?? join(homedir(), ".cache", "astrograph-eval");

function expandHome(path: string): string {
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function readDir(dir: string, isPrivate: boolean): Promise<Repo[]> {
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	return Promise.all(
		files.sort().map(async (file) => {
			const data = (await Bun.file(join(dir, file)).json()) as Omit<Repo, "name" | "private">;
			const repo = { ...data, name: file.slice(0, -5), private: isPrivate, tasks: data.tasks ?? [] };
			if (repo.path) repo.path = expandHome(repo.path);
			return repo;
		}),
	);
}

/** Every repository this machine can run; private ones whose path is missing are reported and skipped. */
export async function loadRepos(): Promise<Repo[]> {
	const repos = [...(await readDir(join(ROOT, "repos"), false)), ...(await readDir(join(ROOT, "local"), true))];
	return repos.filter((repo) => {
		if (!repo.path || existsSync(repo.path)) return true;
		console.error(`skip ${repo.name}: not found at ${repo.path}`);
		return false;
	});
}

function git(cwd: string, ...args: string[]): void {
	const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
	if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}\n${run.stderr.toString()}`);
}

/** A clean checkout of the pinned commit, reused across runs. */
export function materialize(repo: Repo): string {
	const dir = join(CACHE, `${repo.name}-${repo.commit.slice(0, 12)}`);
	if (existsSync(join(dir, ".git", "eval-ready"))) return dir;
	Bun.spawnSync(["rm", "-rf", dir]);
	Bun.spawnSync(["mkdir", "-p", dir]);
	const source = repo.url ?? repo.path;
	if (!source) throw new Error(`${repo.name}: needs a url or a path`);
	console.error(`fetching ${repo.name} @ ${repo.commit.slice(0, 12)}`);
	git(dir, "init", "-q");
	git(dir, "fetch", "-q", "--depth", "1", source, repo.commit);
	git(dir, "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD");
	// Keep the index and the eval's skill out of grep/rg results.
	Bun.spawnSync(
		["sh", "-c", "printf '.astrograph/\\n.claude/skills/astrograph/\\n' >> .git/info/exclude && touch .git/eval-ready"],
		{
			cwd: dir,
		},
	);
	return dir;
}
