import { basename } from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";

export interface CliContext {
	cwd: string;
}

export interface CliRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export class CliError extends Error {
	constructor(
		message: string,
		readonly exitCode = 1,
	) {
		super(message);
		this.name = "CliError";
	}
}

export function ok(stdout = ""): CliRunResult {
	return { exitCode: 0, stdout: stdout === "" || stdout.endsWith("\n") ? stdout : `${stdout}\n`, stderr: "" };
}

export const style = {
	bold: pc.bold,
	dim: pc.dim,
	info: pc.cyan,
	path: pc.underline,
	success: pc.green,
	warn: pc.yellow,
	error: pc.red,
};

export const symbols = { arrow: "→", bullet: "•" };

type OptionConfig = Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>;

export interface ParsedArgs {
	values: Record<string, string | boolean | undefined>;
	positionals: string[];
}

export function parseCommandArgs(args: string[], options: OptionConfig = {}): ParsedArgs {
	try {
		const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
		return { values: parsed.values as ParsedArgs["values"], positionals: parsed.positionals };
	} catch (error) {
		throw new CliError(`${error instanceof Error ? error.message : String(error)}\nUse --help for usage.`);
	}
}

export function stringValue(values: ParsedArgs["values"], name: string): string | undefined {
	const value = values[name];
	return typeof value === "string" ? value : undefined;
}

export function booleanValue(values: ParsedArgs["values"], name: string): boolean {
	return values[name] === true;
}

/** Absolute path of the compiled binary, or undefined when running from source under Bun. */
export function selfBinaryPath(): string | undefined {
	const entry = process.argv[1];
	if (entry && /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(entry)) return process.execPath;
	if (entry && /\.(?:tsx?|jsx?|mjs|cjs)$/.test(entry)) return undefined;
	const exec = basename(process.execPath ?? "").replace(/\.exe$/i, "");
	return ["bun", "bun-debug", "bunx", "node"].includes(exec) ? undefined : process.execPath;
}
