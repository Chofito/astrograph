/**
 * A/B eval: the same task answered by Claude Code with and without the
 * Astrograph MCP server, recording tool calls, tokens, cost and correctness.
 *
 *   bun run eval [--model <id>] [--arm with|without] [filter...]
 *   bun run eval --clean      delete the cached clones of public repositories
 *
 * A filter keeps the repositories whose name, or the tasks whose id, starts
 * with it. Repositories and tasks come from eval/repos/ and eval/local/ (see
 * scripts/repos.ts). Transcripts and results go to eval/results/<timestamp>/.
 *
 * Both arms run in a clean environment with read-only tools, no MCP server
 * but the one given here (--strict-mcp-config) and no user settings or skills
 * (--setting-sources project). The run with Astrograph gets what
 * `astrograph install` sets up: the MCP server, run from this checkout so the
 * eval measures this branch, and the skill, loaded as a plugin (--plugin-dir)
 * so nothing is written into the repository.
 */
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanCache, loadRepos, materialize, revision, type Task } from "./repos";

type Arm = "with" | "without";

interface Run {
	repo: string;
	commit: string;
	dirty: boolean;
	task: string;
	arm: Arm;
	ok: boolean;
	calls: number;
	astrographCalls: number;
	tokens: number;
	outputTokens: number;
	costUsd: number;
	seconds: number;
	score: number;
	missing: string[];
	answer: string;
}

const BIN = join(import.meta.dir, "..", "src", "bin.ts");
const SKILL = join(import.meta.dir, "..", "agents", "astrograph");
const TOOLS = ["Read", "Grep", "Glob", "Bash", "ToolSearch", "Skill"];
/** Pre-approved under --permission-mode dontAsk; any other Bash command is denied. */
const ALLOWED = [
	...TOOLS.filter((t) => t !== "Bash"),
	"Bash(ls:*)",
	"Bash(cat:*)",
	"Bash(head:*)",
	"Bash(tail:*)",
	"Bash(wc:*)",
	"Bash(find:*)",
	"Bash(grep:*)",
	"Bash(rg:*)",
	"Bash(git log:*)",
	"Bash(git grep:*)",
	"Bash(git show:*)",
];
// Nothing from the calling shell or agent session (CLAUDE_CODE_*, CLAUDE_EFFORT, …) leaks into a run.
const CLEAN_ENV = Object.fromEntries(
	["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "ANTHROPIC_API_KEY"].flatMap((k) =>
		process.env[k] ? [[k, process.env[k]]] : [],
	),
);
const PROMPT_SUFFIX =
	"\n\nAnswer from this repository's source. Name the files and symbols involved. Do not modify any file.";

function option(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	if (i === -1) return undefined;
	const [value] = args.splice(i, 2).slice(1);
	return value;
}

const args = process.argv.slice(2);
if (args.includes("--clean")) {
	cleanCache();
	process.exit(0);
}
const model = option(args, "--model") ?? "claude-sonnet-5-5";
const onlyArm = option(args, "--arm") as Arm | undefined;
const arms: Arm[] = onlyArm ? [onlyArm] : ["without", "with"];
const filters = args;

const outDir = join(import.meta.dir, "..", "eval", "results", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });
const mcpConfig = join(outDir, "mcp.json");
await Bun.write(
	mcpConfig,
	JSON.stringify({ mcpServers: { astrograph: { command: "bun", args: [BIN, "serve", "--mcp"] } } }),
);
const plugin = join(outDir, "plugin");
await Bun.write(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "astrograph-eval" }));
cpSync(SKILL, join(plugin, "skills", "astrograph"), { recursive: true });

function grade(answer: string, expect: Task["expect"]): { score: number; missing: string[] } {
	const text = answer.toLowerCase();
	const missing = expect
		.map((fact) => (Array.isArray(fact) ? fact : [fact]))
		.filter((alternatives) => !alternatives.some((a) => text.includes(a.toLowerCase())))
		.map((alternatives) => alternatives.join(" | "));
	return { score: expect.length === 0 ? 1 : 1 - missing.length / expect.length, missing };
}

async function runTask(
	dir: string,
	repo: { name: string; commit: string; dirty: boolean },
	task: Task,
	arm: Arm,
): Promise<Run> {
	const cmd = [
		"claude",
		"-p",
		task.prompt + PROMPT_SUFFIX,
		"--model",
		model,
		"--output-format",
		"stream-json",
		"--verbose",
		"--no-session-persistence",
		"--setting-sources",
		"project",
		"--strict-mcp-config",
		...(arm === "with" ? ["--mcp-config", mcpConfig, "--plugin-dir", plugin] : []),
		"--tools",
		TOOLS.join(","),
		"--permission-mode",
		"dontAsk",
		"--allowedTools",
		[...ALLOWED, ...(arm === "with" ? ["mcp__astrograph"] : [])].join(","),
	];
	const started = performance.now();
	const proc = Bun.spawn(cmd, { cwd: dir, env: CLEAN_ENV, stdout: "pipe", stderr: "pipe" });
	const [transcript, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	await Bun.write(join(outDir, `${task.id}.${arm}.jsonl`), transcript);

	let calls = 0;
	let astrographCalls = 0;
	let result: Record<string, unknown> | undefined;
	let mcpConnected = arm === "without";
	for (const line of transcript.split("\n")) {
		if (!line.trim()) continue;
		const event = JSON.parse(line);
		if (event.type === "system" && event.subtype === "init") {
			mcpConnected ||= event.mcp_servers?.some(
				(s: { name: string; status: string }) => s.name === "astrograph" && s.status === "connected",
			);
		} else if (event.type === "assistant") {
			for (const block of event.message?.content ?? []) {
				if (block.type !== "tool_use") continue;
				calls++;
				if (String(block.name).startsWith("mcp__astrograph")) astrographCalls++;
			}
		} else if (event.type === "result") result = event;
	}

	const usage = (result?.usage ?? {}) as Record<string, number>;
	const answer = typeof result?.result === "string" ? result.result : "";
	const ok = proc.exitCode === 0 && result?.is_error === false && mcpConnected;
	if (!ok) {
		const why = mcpConnected ? stderr.trim() : "astrograph MCP did not connect";
		console.error(`  ${task.id} ${arm}: failed (${why || `exit ${proc.exitCode}`})`);
	}
	return {
		repo: repo.name,
		commit: repo.commit,
		dirty: repo.dirty,
		task: task.id,
		arm,
		ok,
		calls,
		astrographCalls,
		tokens:
			(usage.input_tokens ?? 0) +
			(usage.cache_creation_input_tokens ?? 0) +
			(usage.cache_read_input_tokens ?? 0) +
			(usage.output_tokens ?? 0),
		outputTokens: usage.output_tokens ?? 0,
		costUsd: Number(result?.total_cost_usd ?? 0),
		seconds: Math.round((performance.now() - started) / 1000),
		...grade(answer, task.expect),
		answer,
	};
}

const runs: Run[] = [];
for (const repo of await loadRepos()) {
	const repoMatch = filters.length === 0 || filters.some((f) => repo.name.startsWith(f));
	const tasks = repoMatch ? repo.tasks : repo.tasks.filter((t) => filters.some((f) => t.id.startsWith(f)));
	if (tasks.length === 0) continue;

	const dir = materialize(repo);
	const seen = { name: repo.name, ...revision(dir) };
	if (repo.private)
		console.error(`${repo.name}: ${seen.commit.slice(0, 12)}${seen.dirty ? " + uncommitted changes" : ""}`);
	if (arms.includes("with")) {
		const started = performance.now();
		const index = Bun.spawnSync(["bun", BIN, "init", dir], { stdout: "ignore", stderr: "pipe" });
		if (index.exitCode !== 0) throw new Error(`${repo.name}: index failed\n${index.stderr.toString()}`);
		console.error(`${repo.name}: indexed in ${Math.round(performance.now() - started)} ms`);
	}
	for (const task of tasks) {
		for (const arm of arms) {
			const run = await runTask(dir, seen, task, arm);
			runs.push(run);
			await Bun.write(join(outDir, "runs.json"), `${JSON.stringify(runs, null, "\t")}\n`);
			console.error(
				`  ${task.id} ${arm.padEnd(7)} ${run.calls} calls (${run.astrographCalls} astrograph), ${run.tokens} tokens, $${run.costUsd.toFixed(3)}, score ${run.score.toFixed(2)}`,
			);
		}
	}
}

// One row per task: without → with, so the difference reads left to right.
const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`\n${"task".padEnd(28)} ${pad("calls", 11)} ${pad("tokens", 19)} ${pad("cost $", 13)} ${pad("score", 11)}`);
const tasksRun = [...new Set(runs.map((r) => r.task))];
const sum = { without: { calls: 0, tokens: 0, cost: 0, score: 0 }, with: { calls: 0, tokens: 0, cost: 0, score: 0 } };
for (const id of tasksRun) {
	const cell = (arm: Arm) => runs.find((r) => r.task === id && r.arm === arm);
	const a = cell("without");
	const b = cell("with");
	for (const [arm, r] of [
		["without", a],
		["with", b],
	] as const) {
		if (!r) continue;
		sum[arm].calls += r.calls;
		sum[arm].tokens += r.tokens;
		sum[arm].cost += r.costUsd;
		sum[arm].score += r.score;
	}
	const pair = (f: (r: Run) => string) => `${a ? f(a) : "-"} → ${b ? f(b) : "-"}`;
	console.log(
		`${id.padEnd(28)} ${pad(
			pair((r) => String(r.calls)),
			11,
		)} ${pad(
			pair((r) => String(r.tokens)),
			19,
		)} ${pad(
			pair((r) => r.costUsd.toFixed(2)),
			13,
		)} ${pad(
			pair((r) => r.score.toFixed(1)),
			11,
		)}`,
	);
}
const n = tasksRun.length;
if (n > 0) {
	const total = (arm: Arm) => sum[arm];
	console.log(
		`${"total".padEnd(28)} ${pad(`${total("without").calls} → ${total("with").calls}`, 11)} ${pad(`${total("without").tokens} → ${total("with").tokens}`, 19)} ${pad(`${total("without").cost.toFixed(2)} → ${total("with").cost.toFixed(2)}`, 13)} ${pad(`${(total("without").score / n).toFixed(2)} → ${(total("with").score / n).toFixed(2)}`, 11)}`,
	);
}
console.log(`\nresults: ${outDir}`);
