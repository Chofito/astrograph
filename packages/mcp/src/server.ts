import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pkg from '../package.json';
import { SERVER_INSTRUCTIONS } from './instructions';
import { MissingIndexError, ProjectSession, findProjectRoot, type ProjectSessionOptions } from './project';
import { createTools, type McpToolDefinition } from './tools';
import * as style from './style';

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

export function createAstrographMcpServer(options: ServeMcpOptions = {}): AstrographMcpServer {
  const server = new Server(
    { name: 'astrograph', version: pkg.version },
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
    return callTool(byName, request.params.name, request.params.arguments ?? {});
  });

  return { server, session };
}

export async function serveMcp(options: ServeMcpOptions = {}): Promise<void> {
  const { server, session } = createAstrographMcpServer(options);
  
  const watchEnabled = options.watch ?? true;
  const startPath = options.path ?? options.cwd ?? process.cwd();
  const projectRoot = findProjectRoot(startPath);
  
  if (projectRoot === undefined) {
    process.stderr.write(style.error(`No index at ${startPath} — run \`astrograph init\``) + '\n');
    process.exit(1);
  }
  
  try {
    const graph = await session.getGraph();
    const stats = await graph.getStats({});
    const { fileCount, coverage } = stats.data;
    
    const lines = [
      style.bold(`Astrograph MCP v${pkg.version}`),
      `Project   ${style.dim(projectRoot)}`,
      `Index     ${style.num(fileCount)} files ${style.symbols.bullet} coverage ${style.num(coverage.resolved)}/${style.num(coverage.total)}`,
      `Watch     ${watchEnabled ? 'enabled' : 'disabled'}`,
      style.arrow('Listening on stdio'),
    ];
    process.stderr.write(lines.join('\n') + '\n');
  } catch (error) {
    const lines = [
      style.bold(`Astrograph MCP v${pkg.version}`),
      `Project   ${style.dim(projectRoot)}`,
      `Watch     ${watchEnabled ? 'enabled' : 'disabled'}`,
      style.arrow('Listening on stdio'),
    ];
    process.stderr.write(lines.join('\n') + '\n');
  }
  
  const close = async (): Promise<void> => {
    session.close();
    await server.close();
    process.stderr.write(style.success('Stopped') + '\n');
  };
  process.once('SIGINT', () => {
    void close().then(() => {
      process.exit(0);
    });
  });
  process.once('SIGTERM', () => {
    void close().then(() => {
      process.exit(0);
    });
  });
  await server.connect(new StdioServerTransport());
}

export function createProjectSessionForTest(options: ProjectSessionOptions): ProjectSession {
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
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function formatToolError(error: unknown): string {
  if (error instanceof MissingIndexError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
