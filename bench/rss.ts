/**
 * Measure peak RSS while indexing a repo.
 *
 * Usage: bun run bench -- /path/to/repo
 *
 * Writes docs/benchmarks/latest.json. Target (docs/testing.md §6):
 * peak RSS < 1.5 GB on ~2k files. Fail the process if peak > 2× that.
 */
import { mkdir } from "node:fs/promises";
import { openProject } from "../packages/core/src/adapters/bun/project";

const TARGET_BYTES = 1.5 * 1024 * 1024 * 1024;
const FAIL_AT = TARGET_BYTES * 2;

const repo = process.argv[2];
if (repo === undefined || repo === "") {
	console.error("usage: bun run bench -- <repo-path>");
	process.exit(2);
}

function rss(): number {
	return process.memoryUsage().rss;
}

const before = rss();
let peak = before;
const timer = setInterval(() => {
	peak = Math.max(peak, rss());
}, 50);

const graph = await openProject(repo, { dbPath: ":memory:" });
const started = Date.now();
try {
	await graph.indexAll();
	peak = Math.max(peak, rss());
} finally {
	clearInterval(timer);
	graph.close();
}

const elapsedMs = Date.now() - started;
const after = rss();
peak = Math.max(peak, after);

const report = {
	repo,
	elapsedMs,
	rssBytes: { before, after, peak },
	rssMb: {
		before: mb(before),
		after: mb(after),
		peak: mb(peak),
	},
	targetMb: mb(TARGET_BYTES),
	gateMb: mb(FAIL_AT),
	ok: peak <= FAIL_AT,
};

await mkdir("docs/benchmarks", { recursive: true });
await Bun.write(
	"docs/benchmarks/latest.json",
	`${JSON.stringify(report, null, 2)}\n`,
);

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
	console.error(
		`peak RSS ${report.rssMb.peak} MB exceeds 2× target ${report.gateMb} MB`,
	);
	process.exit(1);
}

function mb(bytes: number): number {
	return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}
