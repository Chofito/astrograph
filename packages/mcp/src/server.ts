import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import pkg from "../package.json";
import { SERVER_INSTRUCTIONS } from "./instructions";
import {
	MissingIndexError,
	ProjectSession,
	type ProjectSessionOptions,
} from "./project";
import { createTools, type McpToolDefinition } from "./tools";

export interface ServeMcpOptions {
	cwd?: string;
	path?: string;
	watch?: boolean;
}

export interface AstrographMcpServer {
	server: Server;
	session: ProjectSession;
}

export type McpTextResult = CallToolResult;

export function createAstrographMcpServer(
	options: ServeMcpOptions = {},
): AstrographMcpServer {
	const server = new Server(
		{ name: "astrograph", version: pkg.version },
		{ capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
	);
	const session = new ProjectSession({
		cwd: options.cwd,
		path: options.path,
		watch: options.watch ?? true,
		rootsProvider: () => listClientRoots(server),
	});
	const tools = createTools(session);
	const byName = new Map(tools.map((tool) => [tool.name, tool]));

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		return callTool(
			byName,
			request.params.name,
			request.params.arguments ?? {},
		);
	});

	return { server, session };
}

export async function serveMcp(options: ServeMcpOptions = {}): Promise<void> {
	// The MCP server runs headless as a host-spawned subprocess: no banner, no logs,
	// no TUI, no colors. It speaks only the protocol over stdio; tools surface any
	// missing-index/coverage state per request.
	const { server, session } = createAstrographMcpServer(options);

	const close = async (): Promise<void> => {
		session.close();
		await server.close();
	};
	process.once("SIGINT", () => {
		void close().then(() => {
			process.exit(0);
		});
	});
	process.once("SIGTERM", () => {
		void close().then(() => {
			process.exit(0);
		});
	});
	await server.connect(new StdioServerTransport());
}

export function createProjectSessionForTest(
	options: ProjectSessionOptions,
): ProjectSession {
	return new ProjectSession(options);
}

export async function callTool(
	tools: Map<string, McpToolDefinition>,
	name: string,
	args: unknown,
): Promise<McpTextResult> {
	const tool = tools.get(name);
	if (tool === undefined) {
		return textResult(`Unknown Astrograph tool: ${name}`, true);
	}

	try {
		return textResult(await tool.run(args));
	} catch (error) {
		return textResult(formatToolError(error), true);
	}
}

async function listClientRoots(server: Server): Promise<{ uri: string }[]> {
	try {
		const result = await server.listRoots();
		return result.roots.map((root) => ({ uri: root.uri }));
	} catch {
		return [];
	}
}

function textResult(text: string, isError = false): McpTextResult {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
	};
}

function formatToolError(error: unknown): string {
	if (error instanceof MissingIndexError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}
