/**
 * Reference repositories for the eval (and the bench).
 *
 *   eval/repos/<name>.json   public: { url, commit, stack, tasks }  committed
 *   eval/local/<name>.json   private: { path, stack, tasks }        gitignored
 *
 * A public repository is cloned once at its pinned commit into the cache
 * directory and kept there for later runs (`bun run eval --clean` deletes the
 * cache). A private repository is used in place, as it is on disk: nothing is
 * copied, the eval follows the code as it changes, and runs record the commit
 * they saw. Only `.astrograph/` is written into it. A private entry whose path
 * does not exist on this machine is skipped, so anyone can run the public set.
 */
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
	url?: string;
	commit?: string;
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

function git(cwd: string, ...args: string[]): string {
	const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}\n${run.stderr.toString()}`);
	return run.stdout.toString().trim();
}

/** The directory to run in: the private path itself, or the cached clone of the public commit. */
export function materialize(repo: Repo): string {
	if (repo.path) return repo.path;
	if (!repo.url || !repo.commit) throw new Error(`${repo.name}: needs a path, or a url and a commit`);
	const dir = join(CACHE, `${repo.name}-${repo.commit.slice(0, 12)}`);
	if (existsSync(join(dir, ".git", "eval-ready"))) return dir;
	rmSync(dir, { recursive: true, force: true });
	Bun.spawnSync(["mkdir", "-p", dir]);
	console.error(`cloning ${repo.name} @ ${repo.commit.slice(0, 12)} into ${dir}`);
	git(dir, "init", "-q");
	git(dir, "fetch", "-q", "--depth", "1", repo.url, repo.commit);
	git(dir, "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD");
	writeFileSync(join(dir, ".git", "eval-ready"), "");
	return dir;
}

/** The commit a run saw, and whether the working tree had uncommitted changes. */
export function revision(dir: string): { commit: string; dirty: boolean } {
	return { commit: git(dir, "rev-parse", "HEAD"), dirty: git(dir, "status", "--porcelain") !== "" };
}

/** Deletes the cached clones of public repositories; private repositories are never touched. */
export function cleanCache(): void {
	if (!existsSync(CACHE)) {
		console.log(`nothing to clean at ${CACHE}`);
		return;
	}
	const size = Bun.spawnSync(["du", "-sh", CACHE]).stdout.toString().split("\t")[0];
	rmSync(CACHE, { recursive: true, force: true });
	console.log(`removed ${CACHE} (${size})`);
}
