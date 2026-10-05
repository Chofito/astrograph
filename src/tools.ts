import type { Graph, Lookup, SymbolInfo } from "./core";
import {
	formatCallees,
	formatCallers,
	formatContext,
	formatExplore,
	formatFiles,
	formatImpact,
	formatNode,
	formatNotFound,
	formatSearch,
	formatStatus,
	formatTrace,
} from "./format";

export interface Param {
	type: "string" | "number" | "boolean";
	description: string;
	required?: boolean;
	enum?: string[];
	/** CLI: filled from positional arguments ("rest" joins all remaining words). */
	positional?: true | "rest";
}

export type Args = Record<string, string | number | boolean | undefined>;

export interface Tool {
	/** CLI command name; the MCP tool is `astrograph_<name>`. */
	name: string;
	title: string;
	description: string;
	params: Record<string, Param>;
	run(graph: Graph, args: Args): string;
}

const KINDS = ["class", "interface", "trait", "enum", "type", "function", "method", "property", "constant", "variable"];
const LANGS = ["typescript", "tsx", "javascript", "php"];

const symbolParam = (description: string): Param => ({
	type: "string",
	description: `${description} Name, qualified name (Class.method, App\\Foo::bar), path:name, or #id.`,
	required: true,
	positional: true,
});

/** Runs `fn` on the looked-up symbol, or explains why nothing matched. */
function withSymbol(graph: Graph, ref: string, fn: (lookup: Lookup & { symbol: SymbolInfo }) => string): string {
	const lookup = graph.lookup(ref);
	if (!lookup.symbol) return formatNotFound(ref, lookup);
	return fn(lookup as Lookup & { symbol: SymbolInfo });
}

const str = (v: Args[string]) => (v === undefined ? undefined : String(v));
const num = (v: Args[string], fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export const TOOLS: Tool[] = [
	{
		name: "context",
		title: "Astrograph Context",
		description:
			"Start here for 'how does X work' questions: ranks the symbols most related to a task description and returns them with callers, callees and source.",
		params: {
			task: {
				type: "string",
				description: "Task or question in natural language.",
				required: true,
				positional: "rest",
			},
			maxSymbols: { type: "number", description: "Maximum symbols. Default 8." },
			includeCode: { type: "boolean", description: "Include source. Default true." },
			tokenBudget: { type: "number", description: "Approximate token budget for source. Default 6000." },
		},
		run: (graph, a) => {
			const task = String(a.task);
			return formatContext(
				task,
				graph.context({
					task,
					maxSymbols: num(a.maxSymbols, 8),
					includeCode: a.includeCode !== false,
					tokenBudget: num(a.tokenBudget, 6000),
				}),
			);
		},
	},
	{
		name: "search",
		title: "Astrograph Search",
		description: "Find symbols by name across the indexed project.",
		params: {
			query: { type: "string", description: "Name or part of a name.", required: true, positional: true },
			kind: { type: "string", description: "Only this symbol kind.", enum: KINDS },
			lang: { type: "string", description: "Only this language.", enum: LANGS },
			limit: { type: "number", description: "Maximum results. Default 20." },
		},
		run: (graph, a) => {
			const query = String(a.query);
			return formatSearch(
				query,
				graph.search({ query, kind: str(a.kind), lang: str(a.lang), limit: num(a.limit, 20) }),
			);
		},
	},
	{
		name: "node",
		title: "Astrograph Node",
		description: "Show one symbol: location, signature, members, reference counts and optionally its source.",
		params: {
			symbol: symbolParam("Symbol to show."),
			includeCode: { type: "boolean", description: "Include verbatim source. Default false." },
		},
		run: (graph, a) =>
			withSymbol(graph, String(a.symbol), (lookup) =>
				formatNode(lookup, {
					parent: graph.parent(lookup.symbol),
					members: graph.members(lookup.symbol),
					callers: graph.callers(lookup.symbol, 10_000).length,
					callees: graph.callees(lookup.symbol, { limit: 10_000 }).length,
					code: a.includeCode === true ? graph.code(lookup.symbol) : undefined,
				}),
			),
	},
	{
		name: "callers",
		title: "Astrograph Callers",
		description: "List the code that calls, instantiates, extends or renders a symbol.",
		params: {
			symbol: symbolParam("Target symbol."),
			limit: { type: "number", description: "Maximum callers. Default 50." },
		},
		run: (graph, a) =>
			withSymbol(graph, String(a.symbol), (lookup) =>
				formatCallers(lookup, graph.callers(lookup.symbol, num(a.limit, 50))),
			),
	},
	{
		name: "callees",
		title: "Astrograph Callees",
		description: "List the symbols a symbol calls (for a class: what its members call).",
		params: {
			symbol: symbolParam("Source symbol."),
			limit: { type: "number", description: "Maximum callees. Default 50." },
			includeExternal: {
				type: "boolean",
				description: "Also list calls that leave the project or could not be resolved. Default false.",
			},
		},
		run: (graph, a) =>
			withSymbol(graph, String(a.symbol), (lookup) =>
				formatCallees(
					lookup,
					graph.callees(lookup.symbol, { limit: num(a.limit, 50), includeExternal: a.includeExternal === true }),
				),
			),
	},
	{
		name: "impact",
		title: "Astrograph Impact",
		description: "Before editing: find everything that transitively depends on a symbol.",
		params: {
			symbol: symbolParam("Symbol you plan to change."),
			depth: { type: "number", description: "Reverse traversal depth. Default 2." },
		},
		run: (graph, a) => {
			const depth = num(a.depth, 2);
			return withSymbol(graph, String(a.symbol), (lookup) =>
				formatImpact(lookup, graph.impact(lookup.symbol, depth), depth),
			);
		},
	},
	{
		name: "trace",
		title: "Astrograph Trace",
		description: "Find how one symbol reaches another through calls (shortest path).",
		params: {
			from: { type: "string", description: "Starting symbol.", required: true, positional: true },
			to: { type: "string", description: "Destination symbol.", required: true, positional: true },
			maxDepth: { type: "number", description: "Maximum hops. Default 6." },
		},
		run: (graph, a) => {
			const maxDepth = num(a.maxDepth, 6);
			return withSymbol(graph, String(a.from), (from) =>
				withSymbol(graph, String(a.to), (to) =>
					formatTrace(from.symbol, to.symbol, graph.trace(from.symbol, to.symbol, maxDepth), maxDepth),
				),
			);
		},
	},
	{
		name: "explore",
		title: "Astrograph Explore",
		description: "Return source blocks for every symbol matching a bag of names or terms, grouped by file.",
		params: {
			query: {
				type: "string",
				description: "Symbol names or terms, space separated.",
				required: true,
				positional: "rest",
			},
			maxFiles: { type: "number", description: "Maximum files. Default 12." },
		},
		run: (graph, a) => {
			const query = String(a.query);
			return formatExplore(query, graph.explore({ query, maxFiles: num(a.maxFiles, 12) }));
		},
	},
	{
		name: "files",
		title: "Astrograph Files",
		description: "List indexed files with symbol counts and parse errors.",
		params: {
			path: { type: "string", description: "Only files under this directory.", positional: true },
			pattern: { type: "string", description: "Only files matching this glob, e.g. **/*.php." },
			format: { type: "string", description: "Output shape. Default tree.", enum: ["tree", "flat", "grouped"] },
			maxDepth: { type: "number", description: "Maximum tree depth." },
		},
		run: (graph, a) =>
			formatFiles(
				graph.files({ path: str(a.path), pattern: str(a.pattern) }),
				(str(a.format) as "tree" | "flat" | "grouped" | undefined) ?? "tree",
				typeof a.maxDepth === "number" ? a.maxDepth : undefined,
			),
	},
	{
		name: "status",
		title: "Astrograph Status",
		description: "Show index health: file and symbol counts, how many references resolved, parse failures.",
		params: {},
		run: (graph) => formatStatus(graph.status()),
	},
];

export function getTool(name: string): Tool | undefined {
	return TOOLS.find((t) => t.name === name);
}
