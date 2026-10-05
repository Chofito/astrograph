/**
 * Indexing budget check. Rebuilds the index of each repository three times
 * and keeps the best wall time and peak RSS.
 *
 *   bun run bench <repo>...          compare against the saved baseline (exit 1 on >20% regression)
 *   bun run bench --save <repo>...   record a new baseline
 *
 * The baseline is machine-specific, so it is gitignored. Indexing writes
 * `.astrograph/` into each repository: point it at clones, not working copies.
 */
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const TOLERANCE = 1.2;
const RUNS = 3;
const BASELINE = join(import.meta.dir, "..", ".bench-baseline.json");
const BIN = join(import.meta.dir, "..", "src", "bin.ts");

interface Sample {
	ms: number;
	rssMB: number;
}

const args = process.argv.slice(2);
const save = args.includes("--save");
const repos = args.filter((a) => a !== "--save").map((r) => resolve(r));
if (repos.length === 0) {
	console.error("usage: bun run bench [--save] <repo>...");
	process.exit(2);
}

const baseline: Record<string, Sample> = existsSync(BASELINE) ? await Bun.file(BASELINE).json() : {};
let failed = false;

for (const repo of repos) {
	let best: Sample | undefined;
	for (let i = 0; i < RUNS; i++) {
		const started = performance.now();
		const run = Bun.spawnSync(["bun", BIN, "index", "--force", repo], { stdout: "ignore", stderr: "pipe" });
		const ms = Math.round(performance.now() - started);
		if (run.exitCode !== 0) {
			console.error(`${repo}: index failed\n${run.stderr.toString()}`);
			process.exit(1);
		}
		const rssMB = Math.round((run.resourceUsage?.maxRSS ?? 0) / 1e6);
		best = { ms: Math.min(best?.ms ?? ms, ms), rssMB: Math.min(best?.rssMB ?? rssMB, rssMB) };
	}
	const sample = best as Sample;
	const before = baseline[repo];
	const line = `${basename(repo)}: ${sample.ms} ms, ${sample.rssMB} MB peak`;
	if (save || !before) {
		baseline[repo] = sample;
		console.log(`${line}  (baseline saved)`);
		continue;
	}
	const slower = sample.ms > before.ms * TOLERANCE;
	const bigger = sample.rssMB > before.rssMB * TOLERANCE;
	failed ||= slower || bigger;
	const status = slower || bigger ? "REGRESSION" : "ok";
	console.log(`${line}  (baseline ${before.ms} ms, ${before.rssMB} MB)  ${status}`);
}

if (save || Object.keys(baseline).length > 0) await Bun.write(BASELINE, `${JSON.stringify(baseline, null, "\t")}\n`);
process.exit(failed ? 1 : 0);
