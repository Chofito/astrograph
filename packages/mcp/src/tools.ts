import type {
  AstrographCore,
  CalleesInput,
  CallersInput,
  ContextInput,
  ExploreInput,
  FilesInput,
  ImpactInput,
  Language,
  NodeInput,
  NodeKind,
  SearchInput,
  StatusInput,
  TraceInput,
} from '@astrograph/core';
import { formatCallees } from './format/callees';
import { formatCallers } from './format/callers';
import { formatContext } from './format/context';
import { formatExplore } from './format/explore';
import { formatFiles } from './format/files';
import { formatImpact } from './format/impact';
import { formatNodeDetails } from './format/node';
import { formatSearch } from './format/search';
import { formatStatus } from './format/status';
import { formatTrace } from './format/trace';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  run(args: unknown): Promise<string>;
}

export interface ToolProjectSession {
  getGraph(projectPath?: string): Promise<AstrographCore>;
}

type Args = Record<string, unknown>;

const NODE_KINDS: NodeKind[] = [
  'file', 'module', 'class', 'interface', 'function', 'method',
  'property', 'field', 'variable', 'constant', 'enum', 'enum_member',
  'type_alias', 'namespace', 'parameter', 'import', 'export', 'component',
];

const LANGUAGES: Language[] = ['typescript', 'tsx', 'javascript', 'jsx'];

export function createTools(session: ToolProjectSession): McpToolDefinition[] {
  return [
    tool('astrograph_search', 'Astrograph Search', 'Find symbols by name across the indexed project.', searchSchema(), async (args) => {
      const input = parseSearch(args);
      return formatSearch(await (await session.getGraph(input.projectPath)).search(input));
    }),
    tool('astrograph_context', 'Astrograph Context', 'Build ranked task context with related symbols and source blocks.', contextSchema(), async (args) => {
      const input = parseContext(args);
      return formatContext(await (await session.getGraph(input.projectPath)).context(input));
    }),
    tool('astrograph_trace', 'Astrograph Trace', 'Trace a call/reference path between two symbols.', traceSchema(), async (args) => {
      const input = parseTrace(args);
      return formatTrace(await (await session.getGraph(input.projectPath)).trace(input));
    }),
    tool('astrograph_callers', 'Astrograph Callers', 'List project symbols that call a symbol.', callersSchema(), async (args) => {
      const input = parseCallers(args);
      return formatCallers(await (await session.getGraph(input.projectPath)).callers(input));
    }),
    tool('astrograph_callees', 'Astrograph Callees', 'List project symbols called by a symbol.', calleesSchema(), async (args) => {
      const input = parseCallees(args);
      return formatCallees(await (await session.getGraph(input.projectPath)).callees(input));
    }),
    tool('astrograph_impact', 'Astrograph Impact', 'Find symbols affected by changing a symbol.', impactSchema(), async (args) => {
      const input = parseImpact(args);
      return formatImpact(await (await session.getGraph(input.projectPath)).impact(input));
    }),
    tool('astrograph_node', 'Astrograph Node', 'Show details and optional source for one symbol.', nodeSchema(), async (args) => {
      const input = parseNode(args);
      return formatNodeDetails(await (await session.getGraph(input.projectPath)).getNode(input));
    }),
    tool('astrograph_explore', 'Astrograph Explore', 'Return source blocks for related symbols grouped by file.', exploreSchema(), async (args) => {
      const input = parseExplore(args);
      return formatExplore(await (await session.getGraph(input.projectPath)).explore(input));
    }),
    tool('astrograph_files', 'Astrograph Files', 'List indexed files and their coverage state.', filesSchema(), async (args) => {
      const input = parseFiles(args);
      return formatFiles(await (await session.getGraph(input.projectPath)).getFiles(input));
    }),
    tool('astrograph_status', 'Astrograph Status', 'Show index health, counts, backend, and coverage.', statusSchema(), async (args) => {
      const input = parseStatus(args);
      return formatStatus(await (await session.getGraph(input.projectPath)).getStats(input));
    }),
  ];
}

function tool(
  name: string,
  title: string,
  description: string,
  inputSchema: JsonSchema,
  run: (args: unknown) => Promise<string>,
): McpToolDefinition {
  return { name, title, description, inputSchema, run };
}

function searchSchema(): JsonSchema {
  return objectSchema({
    query: stringProp('Search query.'),
    kind: enumProp(NODE_KINDS, 'Optional node kind filter.'),
    lang: enumProp(LANGUAGES, 'Optional language filter.'),
    limit: numberProp('Maximum results. Default 10.'),
    includeGenerated: booleanProp('Include generated symbols.'),
    projectPath: stringProp('Optional project path override.'),
  }, ['query']);
}

function contextSchema(): JsonSchema {
  return objectSchema({
    task: stringProp('Task or natural-language question.'),
    maxSymbols: numberProp('Maximum symbols. Default 20.'),
    includeCode: booleanProp('Include verbatim code blocks. Default true.'),
    tokenBudget: numberProp('Approximate token budget.'),
    projectPath: stringProp('Optional project path override.'),
  }, ['task']);
}

function traceSchema(): JsonSchema {
  return objectSchema({
    from: stringProp('Source symbol name or id.'),
    to: stringProp('Destination symbol name or id.'),
    maxDepth: numberProp('Maximum traversal depth.'),
    projectPath: stringProp('Optional project path override.'),
  }, ['from', 'to']);
}

function callersSchema(): JsonSchema {
  return objectSchema({
    symbol: stringProp('Target symbol.'),
    limit: numberProp('Maximum callers. Default 20.'),
    includeExternal: booleanProp('Include external callers. Default false.'),
    projectPath: stringProp('Optional project path override.'),
  }, ['symbol']);
}

function calleesSchema(): JsonSchema {
  return objectSchema({
    symbol: stringProp('Source symbol.'),
    limit: numberProp('Maximum callees. Default 20.'),
    includeExternal: booleanProp('Include external callees. Default false.'),
    projectPath: stringProp('Optional project path override.'),
  }, ['symbol']);
}

function impactSchema(): JsonSchema {
  return objectSchema({
    symbol: stringProp('Changed symbol.'),
    depth: numberProp('Reverse traversal depth. Default 2.'),
    includeExternal: booleanProp('Include external symbols. Default false.'),
    projectPath: stringProp('Optional project path override.'),
  }, ['symbol']);
}

function nodeSchema(): JsonSchema {
  return objectSchema({
    symbol: stringProp('Symbol name or id.'),
    includeCode: booleanProp('Include verbatim source. Default false.'),
    projectPath: stringProp('Optional project path override.'),
  }, ['symbol']);
}

function exploreSchema(): JsonSchema {
  return objectSchema({
    query: stringProp('Bag of symbol names or terms.'),
    maxFiles: numberProp('Maximum files. Default 12.'),
    projectPath: stringProp('Optional project path override.'),
  }, ['query']);
}

function filesSchema(): JsonSchema {
  return objectSchema({
    path: stringProp('Optional path prefix.'),
    pattern: stringProp('Optional glob pattern.'),
    format: enumProp(['tree', 'flat', 'grouped'], 'Output shape. Default tree.'),
    includeMetadata: booleanProp('Include metadata. Default true.'),
    maxDepth: numberProp('Maximum tree depth.'),
    projectPath: stringProp('Optional project path override.'),
  });
}

function statusSchema(): JsonSchema {
  return objectSchema({
    projectPath: stringProp('Optional project path override.'),
  });
}

function parseSearch(raw: unknown): SearchInput {
  const args = record(raw);
  return {
    query: requiredString(args, 'query'),
    kind: optionalEnum(args, 'kind', NODE_KINDS),
    lang: optionalEnum(args, 'lang', LANGUAGES),
    limit: optionalNumber(args, 'limit'),
    includeGenerated: optionalBoolean(args, 'includeGenerated'),
    projectPath: optionalString(args, 'projectPath'),
  };
}

function parseContext(raw: unknown): ContextInput {
  const args = record(raw);
  return {
    task: requiredString(args, 'task'),
    maxSymbols: optionalNumber(args, 'maxSymbols'),
    includeCode: optionalBoolean(args, 'includeCode'),
    tokenBudget: optionalNumber(args, 'tokenBudget'),
    projectPath: optionalString(args, 'projectPath'),
  };
}

function parseTrace(raw: unknown): TraceInput {
  const args = record(raw);
  return {
    from: requiredString(args, 'from'),
    to: requiredString(args, 'to'),
    maxDepth: optionalNumber(args, 'maxDepth'),
    projectPath: optionalString(args, 'projectPath'),
  };
}

function parseCallers(raw: unknown): CallersInput {
  const args = record(raw);
  return {
    symbol: requiredString(args, 'symbol'),
    limit: optionalNumber(args, 'limit'),
    includeExternal: optionalBoolean(args, 'includeExternal'),
    projectPath: optionalString(args, 'projectPath'),
  };
}

function parseCallees(raw: unknown): CalleesInput {
  const args = record(raw);
  return {
    symbol: requiredString(args, 'symbol'),
    limit: optionalNumber(args, 'limit'),
    includeExternal: optionalBoolean(args, 'includeExternal'),
    projectPath: optionalString(args, 'projectPath'),
  };
}

function parseImpact(raw: unknown): ImpactInput {
  const args = record(raw);
  return {
    symbol: requiredString(args, 'symbol'),
    depth: optionalNumber(args, 'depth'),
    includeExternal: optionalBoolean(args, 'includeExternal'),
    projectPath: optionalString(args, 'projectPath'),
  };
}

function parseNode(raw: unknown): NodeInput {
  const args = record(raw);
  return {
    symbol: requiredString(args, 'symbol'),
    includeCode: optionalBoolean(args, 'includeCode'),
    projectPath: optionalString(args, 'projectPath'),
  };
}

function parseExplore(raw: unknown): ExploreInput {
  const args = record(raw);
  return {
    query: requiredString(args, 'query'),
    maxFiles: optionalNumber(args, 'maxFiles'),
    projectPath: optionalString(args, 'projectPath'),
  };
}

function parseFiles(raw: unknown): FilesInput {
  const args = record(raw);
  return {
    path: optionalString(args, 'path'),
    pattern: optionalString(args, 'pattern'),
    format: optionalEnum(args, 'format', ['tree', 'flat', 'grouped']),
    includeMetadata: optionalBoolean(args, 'includeMetadata'),
    maxDepth: optionalNumber(args, 'maxDepth'),
    projectPath: optionalString(args, 'projectPath'),
  };
}

function parseStatus(raw: unknown): StatusInput {
  const args = record(raw);
  return {
    projectPath: optionalString(args, 'projectPath'),
  };
}

function objectSchema(properties: Record<string, unknown>, required?: string[]): JsonSchema {
  const schema: JsonSchema = { type: 'object', properties, additionalProperties: false };
  if (required !== undefined && required.length > 0) schema.required = required;
  return schema;
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function numberProp(description: string): Record<string, unknown> {
  return { type: 'number', description };
}

function booleanProp(description: string): Record<string, unknown> {
  return { type: 'boolean', description };
}

function enumProp(values: readonly string[], description: string): Record<string, unknown> {
  return { type: 'string', enum: [...values], description };
}

function record(value: unknown): Args {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be an object.');
  return value as Args;
}

function requiredString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new Error(`Expected ${key} to be a non-empty string.`);
  return value;
}

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string.`);
  return value;
}

function optionalNumber(args: Args, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Expected ${key} to be a finite number.`);
  return value;
}

function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Expected ${key} to be a boolean.`);
  return value;
}

function optionalEnum<T extends string>(args: Args, key: string, values: readonly T[]): T | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`Expected ${key} to be one of: ${values.join(', ')}.`);
  }
  return value as T;
}
