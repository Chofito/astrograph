import { existsSync } from "node:fs";
import type { AstrographConfig, ToolResult } from "@astrograph/core";
import { openProject } from "@astrograph/core/bun";
import type { Astrograph } from "@astrograph/core";
import {
	CliError,
	failOnPartial,
	ok,
	type CliContext,
	type CliRunResult,
} from "../cli";
import { jsonEnvelope } from "../format/json";
import { resolveProjectPath, requireProjectRoot } from "../root";

export interface ReadFlags {
	json?: boolean;
	failOnPartial?: boolean;
	path?: string;
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
): Promise<AstrographConfig | undefined> {
	const configPath = `${root}/.astrograph/config.json`;
	if (!existsSync(configPath)) return undefined;
	try {
		return (await Bun.file(configPath).json()) as AstrographConfig;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new CliError(`Invalid .astrograph/config.json: ${message}`, 1);
	}
}
