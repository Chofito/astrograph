import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pkg from "../package.json";
import { NotIndexedError, Project } from "./core";
import { formatFooter } from "./format";
import { type Args, TOOLS, type Tool } from "./tools";

const INSTRUCTIONS = [
	"Astrograph is a local code graph of this workspace (TypeScript, JavaScript, PHP). Use it for structure, call-flow, dependency and impact questions before grepping.",
	'Prefer astrograph_context for "how does X work". Use astrograph_search to find symbols, astrograph_callers / astrograph_callees for call flow, astrograph_trace for "how does X reach Y", astrograph_impact before editing, and astrograph_node or astrograph_explore to read source.',
	"Code blocks in tool results are read from disk at call time: treat them as already read. The index re-syncs changed files before every call.",
	"References tagged [inferred] were matched by a unique method name without knowing the receiver type; double-check them when it matters.",
	"If a tool reports that no .astrograph index exists, offer to run `astrograph init` in the project root.",
].join("\n\n");

/** Serves the tools over stdio. Projects are opened lazily and kept open. */
export async function serveMcp(cwd: string): Promise<void> {
	const server = new Server(
		{ name: "astrograph", version: pkg.version },
		{ capabilities: { tools: {} }, instructions: INSTRUCTIONS },
	);
	const projects = new Map<string, Project>();

	const projectFor = (path: string | undefined): Project => {
		const start = path ?? cwd;
		const cached = projects.get(start);
		if (cached) return cached;
		const project = Project.find(start);
		projects.set(start, project);
		return project;
	};

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOLS.map((tool) => ({
			name: `astrograph_${tool.name}`,
			title: tool.title,
			description: tool.description,
			inputSchema: inputSchema(tool),
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
		const name = request.params.name.replace(/^astrograph_/, "");
		const tool = TOOLS.find((t) => t.name === name);
		if (!tool) return error(`Unknown tool: ${request.params.name}`);
		const raw = (request.params.arguments ?? {}) as Record<string, unknown>;
		try {
			const args = parseArgs(tool, raw);
			const project = projectFor(typeof raw.projectPath === "string" ? raw.projectPath : undefined);
			await project.ensureFresh();
			const text = tool.run(project.graph, args) + formatFooter(project.graph.status());
			return { content: [{ type: "text", text }] };
		} catch (err) {
			if (err instanceof NotIndexedError) return error(err.message);
			return error(err instanceof Error ? err.message : String(err));
		}
	});

	const shutdown = () => {
		for (const project of projects.values()) project.close();
		void server.close().finally(() => process.exit(0));
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	await server.connect(new StdioServerTransport());
}

function inputSchema(tool: Tool) {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const [key, param] of Object.entries(tool.params)) {
		properties[key] = { type: param.type, description: param.description, ...(param.enum ? { enum: param.enum } : {}) };
		if (param.required) required.push(key);
	}
	properties.projectPath = {
		type: "string",
		description: "Optional project path; defaults to the server's working directory.",
	};
	return { type: "object" as const, properties, additionalProperties: false, ...(required.length ? { required } : {}) };
}

function parseArgs(tool: Tool, raw: Record<string, unknown>): Args {
	const args: Args = {};
	for (const [key, param] of Object.entries(tool.params)) {
		let value = raw[key];
		if (value === undefined || value === null || value === "") {
			if (param.required) throw new Error(`Missing required argument: ${key}`);
			continue;
		}
		if (param.type === "number" && typeof value === "string") value = Number(value);
		if (param.type === "boolean" && typeof value === "string") value = value === "true";
		if (typeof value !== param.type || (typeof value === "number" && !Number.isFinite(value))) {
			throw new Error(`Argument ${key} must be a ${param.type}`);
		}
		if (param.enum && !param.enum.includes(value as string)) {
			throw new Error(`Argument ${key} must be one of: ${param.enum.join(", ")}`);
		}
		args[key] = value as string | number | boolean;
	}
	return args;
}

function error(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}
