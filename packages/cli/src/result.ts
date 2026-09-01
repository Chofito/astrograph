/**
 * CLI result vocabulary: the types, the error, and the result constructors.
 *
 * This module imports nothing on purpose. `cli.ts` imports every command, and
 * every command imports this vocabulary back, so anything declared in `cli.ts`
 * is still in its temporal dead zone while the command modules evaluate. That
 * is fine for a value only referenced inside a function body, but a module-scope
 * `class X extends CliError` is evaluated eagerly and throws
 * "Cannot access 'CliError' before initialization" — which killed the whole CLI
 * at import time. Keeping the vocabulary in a leaf module removes the hazard
 * for every future subclass instead of patching one occurrence.
 */

export interface CliContext {
	cwd: string;
}

export interface CliRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export class CliError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "CliError";
		this.exitCode = exitCode;
	}
}

export function ok(stdout = ""): CliRunResult {
	return {
		exitCode: 0,
		stdout: stdout === "" || stdout.endsWith("\n") ? stdout : `${stdout}\n`,
		stderr: "",
	};
}

export function failOnPartial(stdout: string, partial: boolean): CliRunResult {
	return {
		exitCode: partial ? 3 : 0,
		stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n`,
		stderr: "",
	};
}
