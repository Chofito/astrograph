import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	Astrograph,
	AstrographConfig,
	AstrographCore,
	ConfigDiagnostic,
	NormalizedAstrographConfig,
	ToolResult,
	Watcher,
} from "@astrograph/core";
import {
	FreshnessManager,
	parseAstrographConfig,
	SHIPPED_BACKEND_IDS,
} from "@astrograph/core";
import { BunWatcher, openProject } from "@astrograph/core/bun";
import { readActiveDaemon } from "./daemon";

export interface RootHint {
	uri: string;
}

export interface ProjectSessionOptions {
	cwd?: string;
	path?: string;
	rootsProvider?: () => Promise<RootHint[]>;
	open?: (
		root: string,
		opts?: { config?: AstrographConfig },
	) => Promise<Astrograph>;
	watcher?: Watcher;
	watch?: boolean;
}

/** Raised when no pre-existing `.astrograph/` directory can be found upward. */
export class MissingIndexError extends Error {
	constructor(startPath: string) {
		super(
			`No Astrograph index found from ${startPath}. Run \`astrograph init\` first.`,
		);
		this.name = "MissingIndexError";
	}
}

/** MCP presentation for syntactically invalid project configuration JSON. */
export class InvalidMcpConfigJsonError extends Error {
	constructor(message: string) {
		super(`Cannot open project config: invalid JSON: ${message}`);
		this.name = "InvalidMcpConfigJsonError";
	}
}

/** MCP presentation that retains all canonical core configuration diagnostics. */
export class InvalidMcpConfigError extends Error {
	readonly diagnostics: readonly ConfigDiagnostic[];

	constructor(diagnostics: readonly ConfigDiagnostic[]) {
		super(formatConfigDiagnostics(diagnostics));
		this.name = "InvalidMcpConfigError";
		this.diagnostics = diagnostics;
	}
}

/**
 * Lazy single-project MCP session with optional watcher-owned freshness.
 * The session deliberately refuses to initialize an index implicitly.
 */
export class ProjectSession {
	private readonly cwd: string;
	private readonly path: string | undefined;
	private readonly rootsProvider: (() => Promise<RootHint[]>) | undefined;
	private readonly openProjectImpl: (
		root: string,
		opts?: { config?: AstrographConfig },
	) => Promise<Astrograph>;
	private readonly watcher: Watcher | undefined;
	private readonly watch: boolean;

	private graph: Astrograph | undefined;
	private freshness: FreshnessManager | undefined;
	private root: string | undefined;

	constructor(options: ProjectSessionOptions = {}) {
		this.cwd = options.cwd ?? process.cwd();
		this.path = options.path;
		this.rootsProvider = options.rootsProvider;
		this.openProjectImpl = options.open ?? openProject;
		this.watcher = options.watcher ?? new BunWatcher();
		this.watch = options.watch ?? false;
	}

	async getGraph(projectPath?: string): Promise<Astrograph> {
		if (this.graph !== undefined) return this.graph;

		const startPath = await this.resolveStartPath(projectPath);
		const root = findProjectRoot(startPath);
		if (root === undefined) throw new MissingIndexError(startPath);

		const config = await loadConfig(root);
		const activeDaemon = readActiveDaemon(root);
		const graph = await this.openProjectImpl(root, { config });
		if (activeDaemon === undefined) {
			await graph.sync();
		}
		this.graph = graph;
		this.root = root;
		if (this.watch && activeDaemon === undefined) {
			this.freshness = new FreshnessManager({
				root,
				config,
				graph,
				watcher: this.watcher,
			});
			this.freshness.start();
		}
		return graph;
	}

	async runTool<T>(
		projectPath: string | undefined,
		fn: (graph: AstrographCore) => Promise<ToolResult<T>>,
	): Promise<ToolResult<T>> {
		const graph = await this.getGraph(projectPath);
		await this.freshness?.beforeQuery();
		const result = await fn(graph);
		return this.freshness?.decorateResult(result) ?? result;
	}

	get projectRoot(): string | undefined {
		return this.root;
	}

	close(): void {
		this.freshness?.close();
		this.freshness = undefined;
		this.graph?.close();
		this.graph = undefined;
	}

	private async resolveStartPath(projectPath?: string): Promise<string> {
		if (projectPath !== undefined && projectPath !== "")
			return resolve(this.cwd, projectPath);
		if (this.path !== undefined && this.path !== "")
			return resolve(this.cwd, this.path);

		const roots = await this.rootsProvider?.();
		const rootUri = roots?.[0]?.uri;
		if (rootUri !== undefined) return uriToPath(rootUri);

		return this.cwd;
	}
}

/** Find the nearest ancestor containing an Astrograph index directory. */
export function findProjectRoot(startPath: string): string | undefined {
	let current = normalizeStart(startPath);
	while (true) {
		if (existsSync(`${current}/.astrograph`)) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export async function loadConfig(
	root: string,
): Promise<NormalizedAstrographConfig | undefined> {
	const path = `${root}/.astrograph/config.json`;
	if (!existsSync(path)) return undefined;
	let input: unknown;
	try {
		input = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new InvalidMcpConfigJsonError(message);
	}
	const result = parseAstrographConfig(input, {
		knownBackendIds: SHIPPED_BACKEND_IDS,
	});
	if (!result.ok) throw new InvalidMcpConfigError(result.diagnostics);
	return result.config;
}

function formatConfigDiagnostics(
	diagnostics: readonly ConfigDiagnostic[],
): string {
	return [
		"Project configuration is invalid:",
		...diagnostics.map(
			(diagnostic) =>
				`- [${diagnostic.code}] ${diagnostic.path || "/"}: ${diagnostic.message}`,
		),
	].join("\n");
}

function normalizeStart(path: string): string {
	const resolved = resolve(path);
	if (!existsSync(resolved)) return resolved;
	return statSync(resolved).isDirectory() ? resolved : dirname(resolved);
}

function uriToPath(uri: string): string {
	if (uri.startsWith("file://")) return fileURLToPath(uri);
	return uri;
}
