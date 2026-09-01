import { existsSync } from "node:fs";
import type {
	Astrograph,
	ConfigDiagnostic,
	NormalizedAstrographConfig,
	ToolResult,
} from "@astrograph/core";
import { parseAstrographConfig, SHIPPED_BACKEND_IDS } from "@astrograph/core";
import { openProject } from "@astrograph/core/bun";
import { jsonEnvelope } from "../format/json";
import {
	type CliContext,
	CliError,
	type CliRunResult,
	failOnPartial,
	ok,
} from "../result";
import { requireProjectRoot, resolveProjectPath } from "../root";

export interface ReadFlags {
	json?: boolean;
	failOnPartial?: boolean;
	path?: string;
}

/** CLI presentation for syntactically invalid project configuration JSON. */
export class InvalidCliConfigJsonError extends CliError {
	constructor(message: string) {
		super(`Invalid JSON in .astrograph/config.json: ${message}`, 1);
	}
}

/** CLI presentation that retains all canonical core configuration diagnostics. */
export class InvalidCliConfigError extends CliError {
	readonly diagnostics: readonly ConfigDiagnostic[];

	constructor(diagnostics: readonly ConfigDiagnostic[]) {
		super(formatConfigDiagnostics(diagnostics), 1);
		this.diagnostics = diagnostics;
	}
}

export async function withGraph<T>(
	root: string,
	fn: (graph: Astrograph) => Promise<T>,
): Promise<T> {
	const graph = await openProject(root, { config: await loadConfig(root) });
	try {
		return await fn(graph);
	} finally {
		graph.close();
	}
}

export async function openGraphForRead<T>(
	ctx: CliContext,
	flags: ReadFlags,
	fn: (graph: Astrograph) => Promise<ToolResult<T>>,
	format: (result: ToolResult<T>) => string,
): Promise<CliRunResult> {
	const root = requireProjectRoot(resolveProjectPath(ctx.cwd, flags.path));
	const result = await withGraph(root, fn);
	const text = flags.json === true ? jsonEnvelope(result) : format(result);
	return flags.failOnPartial === true
		? failOnPartial(text, result.meta.partial)
		: ok(text);
}

export async function loadConfig(
	root: string,
): Promise<NormalizedAstrographConfig | undefined> {
	const configPath = `${root}/.astrograph/config.json`;
	if (!existsSync(configPath)) return undefined;
	let input: unknown;
	try {
		input = JSON.parse(await Bun.file(configPath).text());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new InvalidCliConfigJsonError(message);
	}
	const result = parseAstrographConfig(input, {
		knownBackendIds: SHIPPED_BACKEND_IDS,
	});
	if (!result.ok) throw new InvalidCliConfigError(result.diagnostics);
	return result.config;
}

function formatConfigDiagnostics(
	diagnostics: readonly ConfigDiagnostic[],
): string {
	return [
		"Invalid .astrograph/config.json:",
		...diagnostics.map(
			(diagnostic) =>
				`  ${diagnostic.path || "/"} [${diagnostic.code}] ${diagnostic.message}`,
		),
	].join("\n");
}
