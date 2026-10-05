import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../../package.json";
import { INDEX_DIR, NotIndexedError, Project, type SyncResult } from "../core";
import { serveMcp } from "../mcp";
import { type Args, TOOLS, type Tool } from "../tools";
import { runInstall } from "./install/command-install";
import { runUninstall } from "./install/command-uninstall";
import { CliError, type CliRunResult, parseCommandArgs, stringValue, style } from "./util";

const USAGE = `astrograph ${pkg.version} — local code graph for TypeScript, JavaScript and PHP

Usage: astrograph <command> [args] [--path <dir>]

Index
  init [dir]              create .astrograph/ and build the index
  index [dir] [--force]   bring the index up to date (--force rebuilds from scratch)
  uninit [dir]            delete the index

Query (re-syncs changed files first)
${TOOLS.map((t) => `  ${usageLine(t).padEnd(24)}${t.description.split(/[:.]/)[0]}`).join("\n")}

Agents
  serve --mcp             run the MCP server over stdio
  install                 register the MCP server and skill with Claude Code, Cursor, Codex, opencode
  uninstall               remove them again

Run \`astrograph <command> --help\` for a command's options.`;

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	try {
		if (!command || command === "help" || command === "--help" || command === "-h") {
			print(USAGE);
			return 0;
		}
		if (command === "--version" || command === "-v" || command === "version") {
			print(pkg.version);
			return 0;
		}
		switch (command) {
			case "init":
				return await runIndex(rest, { create: true });
			case "index":
			case "sync":
				return await runIndex(rest, { create: false });
			case "uninit":
				return runUninit(rest);
			case "serve":
				if (!rest.includes("--mcp")) throw new CliError("usage: astrograph serve --mcp");
				await serveMcp(process.cwd());
				return 0;
			case "install":
				return emit(await runInstall(rest, { cwd: process.cwd() }));
			case "uninstall":
				return emit(await runUninstall(rest, { cwd: process.cwd() }));
		}
		const tool = TOOLS.find((t) => t.name === command);
		if (!tool) throw new CliError(`unknown command "${command}"\n\n${USAGE}`);
		return await runTool(tool, rest);
	} catch (error) {
		if (error instanceof CliError || error instanceof NotIndexedError) {
			process.stderr.write(`${style.error("error:")} ${error.message}\n`);
			return error instanceof CliError ? error.exitCode : 2;
		}
		throw error;
	}
}

async function runIndex(args: string[], opts: { create: boolean }): Promise<number> {
	const parsed = parseCommandArgs(args, { force: { type: "boolean" }, path: { type: "string", short: "p" } });
	const dir = resolve(parsed.positionals[0] ?? stringValue(parsed.values, "path") ?? ".");
	if (parsed.values.force) Project.resetDatabase(dir);
	const project = opts.create || parsed.values.force ? Project.open(dir, { create: true }) : Project.find(dir);
	// The index is a local cache: keep it out of version control without touching the user's .gitignore.
	writeFileSync(join(project.root, INDEX_DIR, ".gitignore"), "*\n");
	try {
		const result = await project.sync({ onProgress: progress });
		if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
		print(summary(project, result));
		return 0;
	} finally {
		project.close();
	}
}

function progress(done: number, total: number) {
	if (!process.stderr.isTTY || total < 200) return;
	process.stderr.write(`\r\x1b[Kindexing ${done}/${total} files`);
}

function summary(project: Project, result: SyncResult): string {
	const status = project.graph.status();
	const changed =
		result.added + result.modified + result.removed === 0
			? "already up to date"
			: `${result.added} added, ${result.modified} changed, ${result.removed} removed`;
	const lines = [
		`${style.success("✓")} ${project.root}: ${changed} in ${result.durationMs} ms`,
		style.dim(`  ${status.files} files · ${status.symbols} symbols · ${status.refs} references`),
	];
	if (result.failed > 0)
		lines.push(style.warn(`  ${result.failed} file(s) failed to parse — see \`astrograph status\``));
	return lines.join("\n");
}

function runUninit(args: string[]): number {
	const dir = resolve(args[0] ?? ".");
	print(Project.remove(dir) ? `removed ${join(dir, INDEX_DIR)}` : `no index at ${dir}`);
	return 0;
}

async function runTool(tool: Tool, argv: string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		print(toolHelp(tool));
		return 0;
	}
	const { args, path } = parseToolArgs(tool, argv);
	const project = Project.find(path ?? process.cwd());
	try {
		await project.sync();
		print(tool.run(project.graph, args));
		return 0;
	} finally {
		project.close();
	}
}

/** Positional params fill in order; `--max-depth 3`, `--maxDepth=3` and `--no-include-code` all work. */
function parseToolArgs(tool: Tool, argv: string[]): { args: Args; path?: string } {
	const args: Args = {};
	const positionals: string[] = [];
	let path: string | undefined;
	const byFlag = new Map(
		Object.keys(tool.params).flatMap((key) => [
			[key.toLowerCase(), key],
			[kebab(key), key],
		]),
	);
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] as string;
		if (!token.startsWith("--") && token !== "-p") {
			positionals.push(token);
			continue;
		}
		const [rawFlag, inline] = token === "-p" ? ["path", undefined] : token.slice(2).split(/=(.*)/s, 2);
		const flag = (rawFlag ?? "").toLowerCase();
		if (flag === "path") {
			path = inline ?? argv[++i];
			continue;
		}
		const negated = flag.startsWith("no-") ? byFlag.get(flag.slice(3)) : undefined;
		if (negated && tool.params[negated]?.type === "boolean") {
			args[negated] = false;
			continue;
		}
		const key = byFlag.get(flag);
		const param = key ? tool.params[key] : undefined;
		if (!key || !param) throw new CliError(`unknown option --${rawFlag}\n\n${toolHelp(tool)}`);
		if (param.type === "boolean") {
			args[key] = inline === undefined ? true : inline !== "false";
			continue;
		}
		const value = inline ?? argv[++i];
		if (value === undefined) throw new CliError(`--${rawFlag} needs a value`);
		if (param.type === "number") {
			const n = Number(value);
			if (!Number.isFinite(n)) throw new CliError(`--${rawFlag} must be a number`);
			args[key] = n;
		} else {
			if (param.enum && !param.enum.includes(value)) {
				throw new CliError(`--${rawFlag} must be one of: ${param.enum.join(", ")}`);
			}
			args[key] = value;
		}
	}
	for (const [key, param] of Object.entries(tool.params)) {
		if (!param.positional || args[key] !== undefined) continue;
		if (param.positional === "rest") {
			if (positionals.length > 0) args[key] = positionals.splice(0).join(" ");
		} else if (positionals.length > 0) {
			args[key] = positionals.shift();
		}
	}
	if (positionals.length > 0) throw new CliError(`unexpected argument "${positionals[0]}"\n\n${toolHelp(tool)}`);
	for (const [key, param] of Object.entries(tool.params)) {
		if (param.required && args[key] === undefined) throw new CliError(`missing <${kebab(key)}>\n\n${toolHelp(tool)}`);
	}
	return { args, path };
}

function usageLine(tool: Tool): string {
	const positionals = Object.entries(tool.params)
		.filter(([, p]) => p.positional)
		.map(([key, p]) => (p.required ? `<${kebab(key)}>` : `[${kebab(key)}]`));
	return [tool.name, ...positionals].join(" ");
}

function toolHelp(tool: Tool): string {
	const lines = [`Usage: astrograph ${usageLine(tool)} [options]`, "", tool.description, "", "Options:"];
	for (const [key, param] of Object.entries(tool.params)) {
		if (param.positional) continue;
		const value = param.type === "boolean" ? "" : param.enum ? ` <${param.enum.join("|")}>` : ` <${param.type}>`;
		lines.push(`  --${kebab(key)}${value}`.padEnd(36) + param.description);
	}
	lines.push(`${"  --path <dir>".padEnd(36)}Project directory (default: nearest indexed parent of cwd).`);
	return lines.join("\n");
}

function kebab(name: string): string {
	return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function print(text: string) {
	process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function emit(result: CliRunResult): number {
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	return result.exitCode;
}
