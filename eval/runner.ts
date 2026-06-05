import { mkdir, rm } from "node:fs/promises";
import { openProject } from "@astrograph/core/bun";
import { EVAL_CASES } from "./cases";
import { PASS_THRESHOLD, scoreContext, scoreSearch } from "./scoring";
import type { EvalCase, EvalResult } from "./types";

interface RunnerOptions {
	repoPath: string;
	fresh: boolean;
}

const options = parseRunnerArgs(Bun.argv.slice(2));
const tempDir = `${tmpBaseDir()}/astrograph-eval-${Bun.nanoseconds()}`;
await mkdir(tempDir, { recursive: false });
const dbPath = `${tempDir}/graph.db`;
const graph = await openProject(options.repoPath, { dbPath });

try {
	await graph.indexAll({ force: options.fresh });
	const results: EvalResult[] = [];

	for (const evalCase of EVAL_CASES) {
		results.push(await runCase(evalCase));
	}

	printReport(options.repoPath, results);
	process.exitCode =
		mean(results.map((result) => result.recall)) >= PASS_THRESHOLD ? 0 : 1;
} finally {
	graph.close();
	await rm(tempDir, { recursive: true, force: true });
}

async function runCase(evalCase: EvalCase): Promise<EvalResult> {
	const start = Bun.nanoseconds();
	if (evalCase.api === "search") {
		const result = await graph.search({
			query: evalCase.query,
			kind: evalCase.kind,
			limit: 20,
		});
		return scoreSearch(evalCase, result.data, elapsed(start));
	}

	const result = await graph.context({
		task: evalCase.query,
		maxSymbols: 20,
		includeCode: false,
	});
	return scoreContext(evalCase, result.data, elapsed(start));
}

function parseRunnerArgs(args: string[]): RunnerOptions {
	const fresh =
		args.includes("--fresh") || Bun.env.ASTROGRAPH_EVAL_FRESH === "1";
	const positionals = args.filter((arg) => arg !== "--fresh");
	return {
		repoPath: resolvePath(
			positionals[0] ?? Bun.env.ASTROGRAPH_EVAL_REPO ?? ".",
		),
		fresh,
	};
}

function printReport(repoPath: string, results: EvalResult[]): void {
	const passed = results.filter((result) => result.pass).length;
	const meanRecall = mean(results.map((result) => result.recall));
	const meanMRR = mean(results.map((result) => result.mrr));

	console.log(`Astrograph Tier 1 eval: ${repoPath}`);
	console.log(`PASS threshold: recall >= ${formatNumber(PASS_THRESHOLD)}`);
	console.log("");
	console.log(
		"case                         status  recall  mrr    ms      missed",
	);
	console.log(
		"---------------------------  ------  ------  -----  ------  ----------------",
	);
	for (const result of results) {
		const missed = result.missed.length === 0 ? "-" : result.missed.join(",");
		console.log(
			[
				pad(result.caseId, 27),
				pad(result.pass ? "PASS" : "FAIL", 6),
				pad(formatNumber(result.recall), 6),
				pad(formatNumber(result.mrr), 5),
				pad(result.latencyMs.toFixed(1), 6),
				missed,
			].join("  "),
		);
	}
	console.log("");
	console.log(
		[
			`summary cases=${results.length}`,
			`passed=${passed}`,
			`meanRecall=${formatNumber(meanRecall)}`,
			`meanMRR=${formatNumber(meanMRR)}`,
		].join(" · "),
	);
}

function elapsed(start: number): number {
	return (Bun.nanoseconds() - start) / 1_000_000;
}

function resolvePath(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
	if (normalized.startsWith("/")) return normalized;
	return `${cwd()}/${normalized}`.replace(/\/\.$/, "");
}

function cwd(): string {
	return (Bun.env.PWD ?? ".").replaceAll("\\", "/").replace(/\/$/, "");
}

function tmpBaseDir(): string {
	return (Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp")
		.replaceAll("\\", "/")
		.replace(/\/$/, "");
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pad(value: string, width: number): string {
	return value.length >= width
		? value
		: `${value}${" ".repeat(width - value.length)}`;
}

function formatNumber(value: number): string {
	return value.toFixed(2);
}
