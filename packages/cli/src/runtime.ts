import { basename } from "node:path";

/**
 * How the current process was started.
 *
 * Two consumers care: the daemon spawner (which must re-invoke this same CLI)
 * and `astrograph install` (which must write a command that a GUI-launched
 * agent host can actually resolve).
 */

/** A dev/linked entry point: `bun run packages/cli/src/bin/astrograph.ts`. */
const SCRIPT_ENTRY = /\.(?:tsx?|jsx?|mjs|cjs)$/;

/** Bun's standalone-binary virtual filesystem root. */
const EMBEDDED_ENTRY = /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/;

/** Known JS runtimes — if one of these is executing us, we are not compiled. */
const RUNTIME_BASENAMES = new Set(["bun", "bun-debug", "bunx", "node", "deno"]);

/** True when running as a `bun build --compile` standalone binary. */
export function isCompiledBinary(): boolean {
	const entry = process.argv[1];
	if (entry !== undefined) {
		if (EMBEDDED_ENTRY.test(entry)) return true;
		if (SCRIPT_ENTRY.test(entry)) return false;
	}
	const exec = basename(process.execPath ?? "").replace(/\.exe$/i, "");
	return !RUNTIME_BASENAMES.has(exec);
}

/**
 * Absolute path of the running astrograph binary, or `undefined` in
 * dev/linked mode where `process.execPath` points at the Bun runtime.
 */
export function selfBinaryPath(): string | undefined {
	if (!isCompiledBinary()) return undefined;
	const exec = process.execPath;
	return exec === undefined || exec === "" ? undefined : exec;
}

/**
 * Argv that re-invokes this same CLI with `args`, usable by `Bun.spawn`.
 * In dev mode this becomes `[bun, "run", <entry>, ...args]`; as a compiled
 * binary it is `[<binary>, ...args]`.
 */
export function selfCommand(args: string[]): string[] {
	const entry = process.argv[1];
	if (!isCompiledBinary() && entry !== undefined) {
		return [process.execPath, "run", entry, ...args];
	}
	return [process.execPath, ...args];
}
