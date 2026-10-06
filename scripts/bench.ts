/**
 * Indexing budget check. Rebuilds the index of each repository three times
 * and keeps the best wall time and peak RSS.
 *
 *   bun run bench <repo>...          compare against the saved baseline (exit 1 on >20% regression)
 *   bun run bench --save <repo>...   record a new baseline
 *
 * A repo is a path or the name of a reference repository in eval/repos/ or
 * eval/local/ (see scripts/repos.ts), which is checked out at its pinned
 * commit. Indexing writes `.astrograph/` into each repository: point paths at
 * clones, not working copies.
 *
 *   --baseline <file>   baseline file (default .bench-baseline.json, gitignored: it is machine-specific)
 *   --bin <bin.ts>      the astrograph entry point to measure (default this checkout's src/bin.ts)
 *
 * CI uses both to compare a pull request against main on the same runner.
 */
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadRepos, materialize } from "./repos";

const TOLERANCE = 1.2;
const RUNS = 3;

interface Sample {
	ms: number;
	rssMB: number;
}

function option(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	if (i === -1) return undefined;
	const [value] = args.splice(i, 2).slice(1);
	return value;
}

const args = process.argv.slice(2);
const baselineFile = resolve(option(args, "--baseline") ?? join(import.meta.dir, "..", ".bench-baseline.json"));
const bin = resolve(option(args, "--bin") ?? join(import.meta.dir, "..", "src", "bin.ts"));
const save = args.includes("--save");
const targets = args.filter((a) => a !== "--save");
if (targets.length === 0) {
	console.error("usage: bun run bench [--save] [--baseline <file>] [--bin <bin.ts>] <repo|name>...");
	process.exit(2);
}

const named = new Map((await loadRepos()).map((repo) => [repo.name, repo]));
const repos = targets.map((target) => {
	const repo = named.get(target);
	return repo ? { key: target, dir: materialize(repo) } : { key: resolve(target), dir: resolve(target) };
});

const baseline: Record<string, Sample> = existsSync(baselineFile) ? await Bun.file(baselineFile).json() : {};
let failed = false;

for (const { key, dir } of repos) {
	let best: Sample | undefined;
	for (let i = 0; i < RUNS; i++) {
		const started = performance.now();
		const run = Bun.spawnSync(["bun", bin, "index", "--force", dir], { stdout: "ignore", stderr: "pipe" });
		const ms = Math.round(performance.now() - started);
		if (run.exitCode !== 0) {
			console.error(`${key}: index failed\n${run.stderr.toString()}`);
			process.exit(1);
		}
		const rssMB = Math.round((run.resourceUsage?.maxRSS ?? 0) / 1e6);
		best = { ms: Math.min(best?.ms ?? ms, ms), rssMB: Math.min(best?.rssMB ?? rssMB, rssMB) };
	}
	const sample = best as Sample;
	const before = baseline[key];
	const line = `${basename(key)}: ${sample.ms} ms, ${sample.rssMB} MB peak`;
	if (save || !before) {
		baseline[key] = sample;
		console.log(`${line}  (baseline saved)`);
		continue;
	}
	const slower = sample.ms > before.ms * TOLERANCE;
	const bigger = sample.rssMB > before.rssMB * TOLERANCE;
	failed ||= slower || bigger;
	const status = slower || bigger ? "REGRESSION" : "ok";
	console.log(`${line}  (baseline ${before.ms} ms, ${before.rssMB} MB)  ${status}`);
}

if (save || Object.keys(baseline).length > 0)
	await Bun.write(baselineFile, `${JSON.stringify(baseline, null, "\t")}\n`);
process.exit(failed ? 1 : 0);
