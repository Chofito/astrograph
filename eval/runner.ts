import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Astrograph, AstrographConfig, ToolMeta } from "@astrograph/core";
import { openProject } from "@astrograph/core/bun";
import { EVAL_CASES } from "./cases";
import {
	CASE_PASS_THRESHOLD,
	expectedLabel,
	type MatchTarget,
	type ScoreOutcome,
	SUITE_RECALL_THRESHOLD,
	scoreContext,
	scoreNodeList,
	scoreSearch,
} from "./scoring";
import type { ArmReport, EvalCase, EvalResult, EvalSummary } from "./types";

// ---------------------------------------------------------------------------
// Arms (A/B)
// ---------------------------------------------------------------------------

interface BackendToggle {
	enabled?: boolean;
	enricher?: boolean;
}

export interface EvalArm {
	name: string;
	description: string;
	/** Passed straight to `openProject`. `undefined` means core defaults. */
	config?: AstrographConfig;
	/** True when the arm relies on core config that may not have landed yet. */
	requiresBackendConfig: boolean;
}

/**
 * `AstrographConfig.backends` is core work in flight. The cast keeps the eval
 * compiling against either version of the type; a core that does not yet read
 * `backends` simply ignores the field, in which case the arm degrades to the
 * default configuration and the comparison prints an all-zero delta — which
 * {@link printComparison} calls out explicitly rather than passing off as
 * "no difference between backends".
 */
function backendConfig(
	backends: Record<string, BackendToggle>,
): AstrographConfig {
	return { backends } as unknown as AstrographConfig;
}

export const DEFAULT_ARM = "full";

export const ARMS: Record<string, EvalArm> = {
	full: {
		name: "full",
		description: "tree-sitter parse + TypeScript compiler enricher (default)",
		requiresBackendConfig: false,
	},
	"tree-sitter": {
		name: "tree-sitter",
		description: "tree-sitter parse only, TypeScript enricher disabled",
		config: backendConfig({ typescript: { enricher: false } }),
		requiresBackendConfig: true,
	},
	"no-typescript": {
		name: "no-typescript",
		description: "TypeScript backend disabled entirely (floor / sanity arm)",
		config: backendConfig({ typescript: { enabled: false } }),
		requiresBackendConfig: true,
	},
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunnerOptions {
	repoPath: string;
	/** Force a full re-index. */
	fresh: boolean;
	/** Arm names, in report order. The first is the comparison baseline. */
	arms: string[];
	/** Arm name -> existing db path to reuse instead of a throwaway temp db. */
	dbPaths: Record<string, string>;
	/** Skip indexing entirely; only valid together with a reused db. */
	skipIndex: boolean;
	/** Downgrade "index was partial" from a failure to a warning. */
	allowPartial: boolean;
	/** Suite gate on mean recall. */
	minRecall: number;
	/** Substring filter on case ids. */
	only?: string;
	json: boolean;
}

export const USAGE = `Usage: bun eval/runner.ts [repoPath] [options]

  --arm <name>          arm to run, repeatable (default: ${DEFAULT_ARM})
  --arms <a,b>          comma-separated arms; the first one is the baseline
  --db <path|arm=path>  reuse an existing index instead of a temp db, repeatable
  --skip-index          do not index at all (requires --db)
  --fresh               force a full re-index
  --allow-partial       warn instead of failing when the index is partial
  --min-recall <n>      suite mean-recall gate (default ${SUITE_RECALL_THRESHOLD})
  --only <substring>    run only cases whose id contains <substring>
  --json                emit JSON instead of the tables
  --list-arms           print the available arms and exit
  --help

Env: ASTROGRAPH_EVAL_REPO, ASTROGRAPH_EVAL_FRESH=1, ASTROGRAPH_EVAL_ARMS, ASTROGRAPH_EVAL_DB`;

export function parseRunnerArgs(args: string[]): RunnerOptions {
	const positionals: string[] = [];
	const arms: string[] = [];
	const dbPaths: Record<string, string> = {};
	let fresh = Bun.env.ASTROGRAPH_EVAL_FRESH === "1";
	let skipIndex = false;
	let allowPartial = false;
	let json = false;
	let only: string | undefined;
	let minRecall = SUITE_RECALL_THRESHOLD;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (arg === "--fresh") fresh = true;
		else if (arg === "--skip-index") skipIndex = true;
		else if (arg === "--allow-partial") allowPartial = true;
		else if (arg === "--json") json = true;
		else if (arg === "--arm" || arg === "--arms") {
			i += 1;
			arms.push(...splitList(nextValue(args, i, arg)));
		} else if (arg === "--db") {
			i += 1;
			addDbSpec(dbPaths, nextValue(args, i, arg));
		} else if (arg === "--only") {
			i += 1;
			only = nextValue(args, i, arg);
		} else if (arg === "--min-recall") {
			i += 1;
			minRecall = Number.parseFloat(nextValue(args, i, arg));
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown flag: ${arg}\n\n${USAGE}`);
		} else positionals.push(arg);
	}

	if (arms.length === 0) {
		arms.push(...splitList(Bun.env.ASTROGRAPH_EVAL_ARMS ?? DEFAULT_ARM));
	}
	const envDb = Bun.env.ASTROGRAPH_EVAL_DB;
	if (envDb !== undefined && Object.keys(dbPaths).length === 0) {
		addDbSpec(dbPaths, envDb);
	}

	for (const arm of arms) {
		if (ARMS[arm] === undefined) {
			throw new Error(
				`Unknown arm: ${arm}. Known arms: ${Object.keys(ARMS).join(", ")}`,
			);
		}
	}
	if (Number.isNaN(minRecall) || minRecall < 0 || minRecall > 1) {
		throw new Error("--min-recall must be a number between 0 and 1");
	}

	// A bare `--db <path>` is unambiguous only when a single arm is running.
	const bare = dbPaths[BARE_DB_KEY];
	if (bare !== undefined) {
		delete dbPaths[BARE_DB_KEY];
		const first = arms[0];
		if (arms.length !== 1 || first === undefined) {
			throw new Error(
				"--db <path> is ambiguous with multiple arms; use --db <arm>=<path>",
			);
		}
		dbPaths[first] = bare;
	}
	for (const arm of Object.keys(dbPaths)) {
		if (!arms.includes(arm)) {
			throw new Error(`--db targets arm "${arm}", which is not being run`);
		}
	}
	if (skipIndex && Object.keys(dbPaths).length === 0) {
		throw new Error("--skip-index requires --db pointing at an existing index");
	}

	return {
		repoPath: resolvePath(
			positionals[0] ?? Bun.env.ASTROGRAPH_EVAL_REPO ?? ".",
		),
		fresh,
		arms,
		dbPaths,
		skipIndex,
		allowPartial,
		minRecall,
		only,
		json,
	};
}

const BARE_DB_KEY = "";

function addDbSpec(target: Record<string, string>, spec: string): void {
	const separator = spec.indexOf("=");
	if (separator === -1) {
		target[BARE_DB_KEY] = resolvePath(spec);
		return;
	}
	target[spec.slice(0, separator)] = resolvePath(spec.slice(separator + 1));
}

function splitList(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

function nextValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export function selectCases(options: RunnerOptions): EvalCase[] {
	if (options.only === undefined) return EVAL_CASES;
	const needle = options.only.toLowerCase();
	return EVAL_CASES.filter((evalCase) =>
		evalCase.id.toLowerCase().includes(needle),
	);
}

export async function runEval(options: RunnerOptions): Promise<ArmReport[]> {
	const cases = selectCases(options);
	if (cases.length === 0) {
		throw new Error(`No cases match --only ${options.only ?? ""}`);
	}

	const reports: ArmReport[] = [];
	for (const armName of options.arms) {
		const arm = ARMS[armName];
		if (arm === undefined) throw new Error(`Unknown arm: ${armName}`);
		reports.push(await runArm(arm, cases, options));
	}
	return reports;
}

export async function runArm(
	arm: EvalArm,
	cases: EvalCase[],
	options: RunnerOptions,
): Promise<ArmReport> {
	const reusedPath = options.dbPaths[arm.name];
	const reusedDb = reusedPath !== undefined;
	const tempDir = reusedDb
		? undefined
		: `${tmpBaseDir()}/astrograph-eval-${arm.name}-${Bun.nanoseconds()}`;
	if (tempDir !== undefined) await mkdir(tempDir, { recursive: true });
	const dbPath = reusedPath ?? `${tempDir}/graph.db`;

	const graph = await openProject(options.repoPath, {
		dbPath,
		config: arm.config,
	});

	try {
		if (!options.skipIndex) {
			await graph.indexAll({ force: options.fresh });
		}

		const results: EvalResult[] = [];
		for (const evalCase of cases) {
			results.push(await runCase(graph, arm.name, evalCase));
		}

		return {
			arm: arm.name,
			description: arm.description,
			repoPath: options.repoPath,
			dbPath,
			reusedDb,
			results,
			summary: summarize(results),
		};
	} finally {
		graph.close();
		if (tempDir !== undefined) {
			await rm(tempDir, { recursive: true, force: true });
		}
	}
}

export async function runCase(
	graph: Astrograph,
	arm: string,
	evalCase: EvalCase,
): Promise<EvalResult> {
	const start = Bun.nanoseconds();
	try {
		return await dispatch(graph, arm, evalCase, start);
	} catch (error) {
		return {
			caseId: evalCase.id,
			api: evalCase.api,
			arm,
			pass: false,
			recall: 0,
			mrr: 0,
			found: [],
			missed: evalCase.expectedSymbols.map(expectedLabel),
			latencyMs: elapsed(start),
			payloadSymbols: 0,
			partial: false,
			notes: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function dispatch(
	graph: Astrograph,
	arm: string,
	evalCase: EvalCase,
	start: number,
): Promise<EvalResult> {
	switch (evalCase.api) {
		case "search": {
			const result = await graph.search({
				query: evalCase.query,
				kind: evalCase.kind,
				limit: 20,
			});
			return toResult({
				evalCase,
				arm,
				start,
				meta: result.meta,
				outcome: scoreSearch(evalCase.expectedSymbols, result.data),
				payloadSymbols: result.data.length,
			});
		}

		case "context": {
			const result = await graph.context({
				task: evalCase.query,
				maxSymbols: evalCase.maxSymbols ?? 20,
				includeCode: false,
			});
			return toResult({
				evalCase,
				arm,
				start,
				meta: result.meta,
				outcome: scoreContext(evalCase.expectedSymbols, result.data),
				payloadSymbols:
					result.data.entryPoints.length + result.data.subgraph.nodes.length,
			});
		}

		case "callers": {
			const result = await graph.callers({ symbol: evalCase.query, limit: 20 });
			// `callers` returns the OTHER endpoint of each edge, never the queried
			// symbol — expectations must name the real neighbours.
			const nodes = result.data.map((entry) => entry.caller);
			return toResult({
				evalCase,
				arm,
				start,
				meta: result.meta,
				outcome: scoreNodeList(evalCase.expectedSymbols, nodes),
				payloadSymbols: nodes.length,
			});
		}

		case "callees": {
			const result = await graph.callees({ symbol: evalCase.query, limit: 20 });
			const nodes = result.data.map((entry) => entry.callee);
			return toResult({
				evalCase,
				arm,
				start,
				meta: result.meta,
				outcome: scoreNodeList(evalCase.expectedSymbols, nodes),
				payloadSymbols: nodes.length,
			});
		}

		case "impact": {
			const result = await graph.impact({
				symbol: evalCase.query,
				depth: evalCase.depth ?? 2,
			});
			const nodes = result.data.map((entry) => entry.node);
			return toResult({
				evalCase,
				arm,
				start,
				meta: result.meta,
				outcome: scoreNodeList(evalCase.expectedSymbols, nodes),
				payloadSymbols: nodes.length,
			});
		}

		case "node": {
			const result = await graph.getNode({
				symbol: evalCase.query,
				includeCode: false,
			});
			const nodes = [
				result.data.node,
				...result.data.callersPreview,
				...result.data.calleesPreview,
			];
			return toResult({
				evalCase,
				arm,
				start,
				meta: result.meta,
				outcome: scoreNodeList(evalCase.expectedSymbols, nodes),
				payloadSymbols: nodes.length,
			});
		}

		case "explore": {
			const result = await graph.explore({
				query: evalCase.query,
				maxFiles: evalCase.maxFiles ?? 12,
			});
			const nodes = result.data.files.map((file) => fileTarget(file.filePath));
			return toResult({
				evalCase,
				arm,
				start,
				meta: result.meta,
				outcome: scoreNodeList(evalCase.expectedSymbols, nodes),
				payloadSymbols: result.data.files.reduce(
					(sum, file) => sum + file.blocks.length,
					0,
				),
			});
		}

		case "files": {
			const result = await graph.getFiles({
				path: evalCase.query,
				pattern: evalCase.pattern,
				format: "flat",
			});
			const nodes = result.data.entries.map((entry) =>
				fileTarget(entry.filePath),
			);
			return toResult({
				evalCase,
				arm,
				start,
				meta: result.meta,
				outcome: scoreNodeList(evalCase.expectedSymbols, nodes),
				payloadSymbols: nodes.length,
			});
		}

		case "trace": {
			const result = await graph.trace({
				from: evalCase.query,
				to: evalCase.traceTo,
				maxDepth: evalCase.maxDepth,
			});
			const found = result.data.found;
			const expectPath = evalCase.expectPath ?? true;
			// `hops` holds the SOURCE node of each edge, so the destination is never
			// in the list — `found` is the only proof it was reached. When no path
			// exists the tool returns a fallback `endpoints` payload instead.
			const nodes: MatchTarget[] = found
				? result.data.hops.map((hop) => hop.node)
				: (result.data.endpoints ?? []).map((endpoint) => endpoint.node);
			const outcome = scoreNodeList(evalCase.expectedSymbols, nodes);
			const base = toResult({
				evalCase,
				arm,
				start,
				meta: result.meta,
				outcome,
				payloadSymbols: nodes.length,
			});
			const asExpected = found === expectPath;
			return {
				...base,
				pathFound: found,
				pass: asExpected && outcome.pass,
				notes: asExpected
					? base.notes
					: [
							...base.notes,
							expectPath
								? "expected a path, trace reported found=false"
								: "expected NO path, trace reported found=true",
						],
			};
		}
	}
}

interface ToResultInput {
	evalCase: EvalCase;
	arm: string;
	start: number;
	meta: ToolMeta;
	outcome: ScoreOutcome;
	payloadSymbols: number;
}

function toResult(input: ToResultInput): EvalResult {
	const pending = input.meta.pendingFiles ?? [];
	return {
		caseId: input.evalCase.id,
		api: input.evalCase.api,
		arm: input.arm,
		pass: input.outcome.pass,
		recall: input.outcome.recall,
		mrr: input.outcome.mrr,
		found: input.outcome.found,
		missed: input.outcome.missed,
		latencyMs: elapsed(input.start),
		payloadSymbols: input.payloadSymbols,
		coverage: input.meta.coverage,
		partial: input.meta.partial,
		notes: [
			...(input.meta.notes ?? []),
			...(pending.length > 0 ? [`${pending.length} pending file(s)`] : []),
		],
	};
}

function fileTarget(filePath: string): MatchTarget {
	const parts = filePath.replaceAll("\\", "/").split("/");
	return {
		name: parts[parts.length - 1] ?? filePath,
		kind: "file",
		filePath,
	};
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function summarize(results: EvalResult[]): EvalSummary {
	const errors = results.filter((result) => result.error !== undefined).length;
	const partialCases = results.filter((result) => result.partial).length;
	const coverageRatios = results.map(coverageRatio);

	return {
		cases: results.length,
		passed: results.filter((result) => result.pass).length,
		errors,
		meanRecall: mean(results.map((result) => result.recall)),
		meanMRR: mean(results.map((result) => result.mrr)),
		meanLatencyMs: mean(results.map((result) => result.latencyMs)),
		meanPayloadSymbols: mean(results.map((result) => result.payloadSymbols)),
		totalPayloadSymbols: results.reduce(
			(sum, result) => sum + result.payloadSymbols,
			0,
		),
		partialCases,
		minCoverageRatio:
			coverageRatios.length === 0 ? 1 : Math.min(...coverageRatios),
		honest: partialCases === 0 && errors === 0,
	};
}

function coverageRatio(result: EvalResult): number {
	const coverage = result.coverage;
	if (coverage === undefined || coverage.total === 0) return 1;
	return coverage.resolved / coverage.total;
}

export function evalExitCode(
	reports: ArmReport[],
	options: RunnerOptions,
): number {
	if (reports.length === 0) return 1;
	for (const report of reports) {
		if (report.summary.errors > 0) return 1;
		if (report.summary.meanRecall < options.minRecall) return 1;
		if (!options.allowPartial && report.summary.partialCases > 0) return 1;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function printReport(report: ArmReport, options: RunnerOptions): void {
	const arm = ARMS[report.arm];
	console.log(`Astrograph eval · arm=${report.arm} · repo=${report.repoPath}`);
	console.log(`  ${report.description}`);
	console.log(
		`  db=${report.dbPath}${report.reusedDb ? " (reused)" : " (temp)"}${
			options.skipIndex ? " · indexing skipped" : ""
		}`,
	);
	console.log(
		`  gates: case recall >= ${formatNumber(CASE_PASS_THRESHOLD)} · suite mean recall >= ${formatNumber(
			options.minRecall,
		)} · partial index = ${options.allowPartial ? "WARN" : "FAIL"}`,
	);
	if (arm?.requiresBackendConfig === true) {
		console.log(
			"  note: this arm needs AstrographConfig.backends support in core; without it it behaves exactly like the default arm",
		);
	}
	console.log("");

	const columns = [30, 8, 6, 6, 5, 7, 7, 6];
	console.log(
		[
			pad("case", 30),
			pad("api", 8),
			pad("status", 6),
			pad("recall", 6),
			pad("mrr", 5),
			pad("ms", 7),
			pad("payload", 7),
			pad("cov", 6),
			"notes / missed",
		].join("  "),
	);
	console.log(
		[...columns.map((width) => "-".repeat(width)), "-".repeat(30)].join("  "),
	);

	for (const result of report.results) {
		console.log(
			[
				pad(result.caseId, 30),
				pad(result.api, 8),
				pad(statusOf(result), 6),
				pad(formatNumber(result.recall), 6),
				pad(formatNumber(result.mrr), 5),
				pad(result.latencyMs.toFixed(1), 7),
				pad(String(result.payloadSymbols), 7),
				pad(formatCoverage(result), 6),
				trailingNotes(result),
			].join("  "),
		);
	}

	const summary = report.summary;
	console.log("");
	console.log(
		[
			`summary arm=${report.arm}`,
			`cases=${summary.cases}`,
			`passed=${summary.passed}`,
			`errors=${summary.errors}`,
			`meanRecall=${formatNumber(summary.meanRecall)}`,
			`meanMRR=${formatNumber(summary.meanMRR)}`,
			`meanPayload=${summary.meanPayloadSymbols.toFixed(1)}`,
			`totalPayload=${summary.totalPayloadSymbols}`,
			`meanMs=${summary.meanLatencyMs.toFixed(1)}`,
		].join(" · "),
	);
	console.log(
		[
			`honesty partial=${summary.partialCases}/${summary.cases}`,
			`minCoverage=${formatNumber(summary.minCoverageRatio)}`,
			`trustworthy=${summary.honest ? "yes" : "NO"}`,
		].join(" · "),
	);
	if (!summary.honest) {
		console.log(
			`  !! ${summary.partialCases} case(s) answered from a partial index, ${summary.errors} errored — the recall above is an upper bound, not a measurement.`,
		);
	}
	console.log("");
}

export function printComparison(reports: ArmReport[]): void {
	const baseline = reports[0];
	if (baseline === undefined || reports.length < 2) return;
	const last = reports[reports.length - 1];

	console.log(`A/B comparison · baseline=${baseline.arm}`);
	console.log("");
	const header = [
		pad("case", 30),
		...reports.map((report) => pad(report.arm, 14)),
		pad("Δrecall", 8),
		"Δpayload",
	].join("  ");
	console.log(header);
	console.log("-".repeat(header.length));

	for (const [index, result] of baseline.results.entries()) {
		const other = last?.results[index];
		console.log(
			[
				pad(result.caseId, 30),
				...reports.map((report) => {
					const cell = report.results[index];
					return pad(cell === undefined ? "-" : formatNumber(cell.recall), 14);
				}),
				pad(
					other === undefined ? "-" : formatDelta(other.recall - result.recall),
					8,
				),
				other === undefined
					? "-"
					: formatDelta(other.payloadSymbols - result.payloadSymbols, 0),
			].join("  "),
		);
	}

	console.log("");
	for (const report of reports.slice(1)) {
		const a = baseline.summary;
		const b = report.summary;
		console.log(
			[
				`${report.arm} vs ${baseline.arm}`,
				`ΔmeanRecall=${formatDelta(b.meanRecall - a.meanRecall)}`,
				`ΔmeanMRR=${formatDelta(b.meanMRR - a.meanMRR)}`,
				`ΔmeanPayload=${formatDelta(b.meanPayloadSymbols - a.meanPayloadSymbols, 1)}`,
				`ΔminCoverage=${formatDelta(b.minCoverageRatio - a.minCoverageRatio)}`,
				`Δpassed=${formatDelta(b.passed - a.passed, 0)}`,
			].join(" · "),
		);
		if (
			b.meanRecall === a.meanRecall &&
			b.totalPayloadSymbols === a.totalPayloadSymbols &&
			ARMS[report.arm]?.requiresBackendConfig === true
		) {
			console.log(
				`  !! ${report.arm} scored identically to ${baseline.arm}. The backend switch was most likely ignored (core does not read AstrographConfig.backends yet) — read this as "not measured", not "no difference".`,
			);
		}
	}
	console.log("");
}

function statusOf(result: EvalResult): string {
	if (result.error !== undefined) return "ERROR";
	return result.pass ? "PASS" : "FAIL";
}

function formatCoverage(result: EvalResult): string {
	const value = formatNumber(coverageRatio(result));
	return result.partial ? `${value}!` : value;
}

function trailingNotes(result: EvalResult): string {
	const parts: string[] = [];
	if (result.error !== undefined) parts.push(`error: ${result.error}`);
	if (result.pathFound === false) parts.push("no-path");
	if (result.missed.length > 0)
		parts.push(`missed: ${result.missed.join(",")}`);
	parts.push(...result.notes);
	return parts.length === 0 ? "-" : parts.join(" | ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(start: number): number {
	return (Bun.nanoseconds() - start) / 1_000_000;
}

/** Resolves against the real process cwd — `Bun.env.PWD` is unset under CI. */
export function resolvePath(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	const absolute = isAbsolute(normalized)
		? normalized
		: resolve(process.cwd(), normalized);
	return absolute.replaceAll("\\", "/").replace(/(.)\/$/, "$1");
}

function tmpBaseDir(): string {
	return (Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp")
		.replaceAll("\\", "/")
		.replace(/(.)\/$/, "$1");
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

function formatDelta(value: number, digits = 2): string {
	const rendered = value.toFixed(digits);
	return value > 0 ? `+${rendered}` : rendered;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(USAGE);
		return 0;
	}
	if (argv.includes("--list-arms")) {
		for (const arm of Object.values(ARMS)) {
			console.log(`${pad(arm.name, 16)}${arm.description}`);
		}
		return 0;
	}

	const options = parseRunnerArgs(argv);
	const reports = await runEval(options);

	if (options.json) {
		console.log(JSON.stringify({ options, reports }, null, 2));
	} else {
		for (const report of reports) printReport(report, options);
		printComparison(reports);
	}

	return evalExitCode(reports, options);
}

if (import.meta.main) {
	process.exitCode = await main(Bun.argv.slice(2));
}
