import { Chalk, type ChalkInstance } from "chalk";

export const symbols = {
	success: "✓",
	error: "✗",
	warn: "⚠",
	info: "ℹ",
	bullet: "•",
	arrow: "→",
} as const;

export interface StyleHelpers {
	success: (msg: string) => string;
	error: (msg: string) => string;
	warn: (msg: string) => string;
	info: (msg: string) => string;
	accent: (text: string) => string;
	subtle: (text: string) => string;
	dim: (text: string) => string;
	bold: (text: string) => string;
	num: (n: number) => string;
	path: (p: string) => string;
	added: (n: number) => string;
	modified: (n: number) => string;
	removed: (n: number) => string;
	header: (text: string) => string;
}

function createStyle(c: ChalkInstance): StyleHelpers {
	return {
		success: (msg) => `${c.green(symbols.success)} ${msg}`,
		error: (msg) => `${c.red(symbols.error)} ${msg}`,
		warn: (msg) => `${c.yellow(symbols.warn)} ${msg}`,
		info: (msg) => `${c.blue(symbols.info)} ${msg}`,
		accent: (text) => c.hex("#A855F7").bold(text),
		subtle: (text) => c.hex("#94A3B8")(text),
		dim: (text) => c.dim(text),
		bold: (text) => c.bold(text),
		num: (n) => c.cyan.bold(String(n)),
		path: (p) => c.dim(p),
		added: (n) => c.green(`+${n}`),
		modified: (n) => c.yellow(`~${n}`),
		removed: (n) => c.red(`-${n}`),
		header: (text) => c.bold(text),
	};
}

const chalkColor = new Chalk({ level: 3 });
const chalkNoColor = new Chalk({ level: 0 });

type ColorEnv = Partial<
	Record<"CI" | "FORCE_COLOR" | "NO_COLOR", string | undefined>
>;

let stdoutStyleCache:
	| {
			key: string;
			helpers: StyleHelpers;
	  }
	| undefined;

export function createTerminalStyle(
	isTTY: boolean | undefined,
	env: ColorEnv = colorEnvFromProcess(),
): StyleHelpers {
	return createStyle(shouldUseColor(isTTY, env) ? chalkColor : chalkNoColor);
}

function getStdoutStyle(): StyleHelpers {
	const env = colorEnvFromProcess();
	const key = [
		process.stdout.isTTY === true ? "tty" : "pipe",
		env.CI ?? "",
		env.FORCE_COLOR ?? "",
		env.NO_COLOR ?? "",
	].join("\0");

	if (stdoutStyleCache?.key !== key) {
		stdoutStyleCache = {
			key,
			helpers: createTerminalStyle(process.stdout.isTTY, env),
		};
	}
	return stdoutStyleCache.helpers;
}

export const style = new Proxy({} as StyleHelpers, {
	get(_target, prop) {
		if (typeof prop !== "string") return undefined;
		return getStdoutStyle()[prop as keyof StyleHelpers];
	},
});

function shouldUseColor(isTTY: boolean | undefined, env: ColorEnv): boolean {
	if (env.NO_COLOR !== undefined) return false;
	if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
	if (env.CI !== undefined) return false;
	return isTTY === true;
}

function colorEnvFromProcess(): ColorEnv {
	return {
		CI: process.env.CI,
		FORCE_COLOR: process.env.FORCE_COLOR,
		NO_COLOR: process.env.NO_COLOR,
	};
}
