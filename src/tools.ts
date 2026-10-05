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
	formatOutline,
	formatSearch,
	formatStatus,
	formatTrace,
	type Page,
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

/** Every tool answers within a token budget and says what it left out. */
const budget = (fallback: number): Param => ({
	type: "number",
	description: `Approximate token budget for the answer. Default ${fallback}. Anything cut is listed with how to get it.`,
});

const paging = (defaultLimit: number): Record<string, Param> => ({
	limit: { type: "number", description: `Maximum items. Default ${defaultLimit}.` },
	offset: { type: "number", description: "Skip this many items (continue a cut list). Default 0." },
});

/** Runs `fn` on the looked-up symbol, or explains why nothing matched. */
function withSymbol(graph: Graph, ref: string, fn: (lookup: Lookup & { symbol: SymbolInfo }) => string): string {
	const lookup = graph.lookup(ref);
	if (!lookup.symbol) return formatNotFound(ref, lookup);
	return fn(lookup as Lookup & { symbol: SymbolInfo });
}

const str = (v: Args[string]) => (v === undefined ? undefined : String(v));
const num = (v: Args[string], fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const page = (a: Args, defaultLimit: number): Page => ({
	offset: Math.max(0, num(a.offset, 0)),
	limit: Math.max(1, num(a.limit, defaultLimit)),
});

export const TOOLS: Tool[] = [
	{
		name: "context",
		title: "Astrograph Context",
		description:
			"Start here for 'how does X work': the symbols most related to a task, with callers, callees and line-numbered source, fitted to a token budget.",
		params: {
			task: {
				type: "string",
				description: "Task or question in natural language.",
				required: true,
				positional: "rest",
			},
			maxSymbols: { type: "number", description: "Maximum symbols. Default 8." },
			includeCode: { type: "boolean", description: "Include source. Default true." },
			maxTokens: budget(6000),
		},
		run: (graph, a) => {
			const task = String(a.task);
			const entries = graph.context({ task, maxSymbols: num(a.maxSymbols, 8), includeCode: a.includeCode !== false });
			return formatContext(task, entries, num(a.maxTokens, 6000));
		},
	},
	{
		name: "outline",
		title: "Astrograph Outline",
		description:
			"Read this before opening a file: signatures and line ranges of everything in a file, a directory (top-level only) or a class, without bodies.",
		params: {
			target: {
				type: "string",
				description: "File path (or unique suffix like repo.ts), directory, or class/interface symbol.",
				required: true,
				positional: true,
			},
			maxTokens: budget(3000),
		},
		run: (graph, a) => {
			const target = String(a.target);
			const maxTokens = num(a.maxTokens, 3000);
			const files = target.startsWith("#") ? [] : graph.matchFiles(target);
			if (files.length > 0) {
				// Lazy: a directory outline stops reading files once the budget is spent.
				const groups = files.map((f) => ({
					path: f.path,
					lines: f.lines,
					get symbols() {
						return graph.fileSymbols(f.path);
					},
				}));
				return formatOutline(target, groups, maxTokens);
			}
			return withSymbol(graph, target, ({ symbol }) => {
				const inside = graph
					.fileSymbols(symbol.path)
					.filter((s) => s.startLine >= symbol.startLine && s.endLine <= symbol.endLine);
				return formatOutline(
					target,
					[
						{
							path: `${symbol.path} (${symbol.kind} ${symbol.qualifiedName})`,
							lines: symbol.endLine - symbol.startLine + 1,
							symbols: inside,
						},
					],
					maxTokens,
				);
			});
		},
	},
	{
		name: "search",
		title: "Astrograph Search",
		description: "Find symbols by (part of) their name across the indexed project.",
		params: {
			query: { type: "string", description: "Name or part of a name.", required: true, positional: true },
			kind: { type: "string", description: "Only this symbol kind.", enum: KINDS },
			lang: { type: "string", description: "Only this language.", enum: LANGS },
			...paging(20),
			maxTokens: budget(1500),
		},
		run: (graph, a) => {
			const query = String(a.query);
			const results = graph.search({ query, kind: str(a.kind), lang: str(a.lang), limit: 1000 });
			return formatSearch(query, results, page(a, 20), num(a.maxTokens, 1500));
		},
	},
	{
		name: "node",
		title: "Astrograph Node",
		description: "One symbol: location, signature, members, reference counts and optionally its line-numbered source.",
		params: {
			symbol: symbolParam("Symbol to show."),
			includeCode: { type: "boolean", description: "Include source. Default false." },
			maxTokens: budget(4000),
		},
		run: (graph, a) =>
			withSymbol(graph, String(a.symbol), (lookup) =>
				formatNode(
					lookup,
					{
						parent: graph.parent(lookup.symbol),
						members: graph.members(lookup.symbol),
						callers: graph.callers(lookup.symbol, 10_000).length,
						callees: graph.callees(lookup.symbol, { limit: 10_000 }).length,
						code: a.includeCode === true ? graph.code(lookup.symbol) : undefined,
					},
					num(a.maxTokens, 4000),
				),
			),
	},
	{
		name: "callers",
		title: "Astrograph Callers",
		description: "The code that calls, instantiates, extends or renders a symbol, grouped by file.",
		params: {
			symbol: symbolParam("Target symbol."),
			...paging(50),
			maxTokens: budget(2000),
		},
		run: (graph, a) =>
			withSymbol(graph, String(a.symbol), (lookup) =>
				formatCallers(lookup, graph.callers(lookup.symbol, 5000), page(a, 50), num(a.maxTokens, 2000)),
			),
	},
	{
		name: "callees",
		title: "Astrograph Callees",
		description: "The symbols a symbol calls (for a class: what its members call).",
		params: {
			symbol: symbolParam("Source symbol."),
			includeExternal: {
				type: "boolean",
				description: "Also list calls that leave the project or could not be resolved. Default false.",
			},
			...paging(50),
			maxTokens: budget(2000),
		},
		run: (graph, a) =>
			withSymbol(graph, String(a.symbol), (lookup) =>
				formatCallees(
					lookup,
					graph.callees(lookup.symbol, { limit: 5000, includeExternal: a.includeExternal === true }),
					page(a, 50),
					num(a.maxTokens, 2000),
				),
			),
	},
	{
		name: "impact",
		title: "Astrograph Impact",
		description: "Before editing: everything that transitively depends on a symbol, by depth and file.",
		params: {
			symbol: symbolParam("Symbol you plan to change."),
			depth: { type: "number", description: "Reverse traversal depth. Default 2." },
			...paging(100),
			maxTokens: budget(2500),
		},
		run: (graph, a) =>
			withSymbol(graph, String(a.symbol), (lookup) =>
				formatImpact(lookup, graph.impact(lookup.symbol, num(a.depth, 2)), page(a, 100), num(a.maxTokens, 2500)),
			),
	},
	{
		name: "trace",
		title: "Astrograph Trace",
		description: "How one symbol reaches another through calls (shortest path).",
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
		description: "Line-numbered source for every symbol matching a bag of names or terms, grouped by file.",
		params: {
			query: {
				type: "string",
				description: "Symbol names or terms, space separated.",
				required: true,
				positional: "rest",
			},
			maxFiles: { type: "number", description: "Maximum files. Default 12." },
			maxTokens: budget(6000),
		},
		run: (graph, a) => {
			const query = String(a.query);
			return formatExplore(query, graph.explore({ query, maxFiles: num(a.maxFiles, 12) }), num(a.maxTokens, 6000));
		},
	},
	{
		name: "files",
		title: "Astrograph Files",
		description: "Indexed files with symbol counts and parse errors.",
		params: {
			path: { type: "string", description: "Only files under this directory.", positional: true },
			pattern: { type: "string", description: "Only files matching this glob, e.g. **/*.php." },
			format: { type: "string", description: "Output shape. Default tree.", enum: ["tree", "flat", "grouped"] },
			maxDepth: { type: "number", description: "Maximum tree depth." },
			...paging(500),
			maxTokens: budget(2500),
		},
		run: (graph, a) =>
			formatFiles(
				graph.files({ path: str(a.path), pattern: str(a.pattern) }),
				(str(a.format) as "tree" | "flat" | "grouped" | undefined) ?? "tree",
				typeof a.maxDepth === "number" ? a.maxDepth : undefined,
				page(a, 500),
				num(a.maxTokens, 2500),
			),
	},
	{
		name: "status",
		title: "Astrograph Status",
		description: "Index health: file and symbol counts, how many references resolved, parse failures.",
		params: {},
		run: (graph) => formatStatus(graph.status()),
	},
];

export function getTool(name: string): Tool | undefined {
	return TOOLS.find((t) => t.name === name);
}
