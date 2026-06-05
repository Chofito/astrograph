import type { EvalCase } from "./types";

export const EVAL_CASES: EvalCase[] = [
	{
		id: "search-node-id",
		api: "search",
		query: "makeNodeId",
		kind: "function",
		expectedSymbols: ["makeNodeId"],
	},
	{
		id: "search-fts-query",
		api: "search",
		query: "fts query",
		expectedSymbols: ["toFtsMatchQuery"],
	},
	{
		id: "search-graph-queries",
		api: "search",
		query: "graph queries",
		expectedSymbols: ["GraphQueries"],
	},
	{
		id: "search-open-project",
		api: "search",
		query: "open project",
		expectedSymbols: ["openProject"],
	},
	{
		id: "search-symbol-lookup",
		api: "search",
		query: "resolve symbol",
		expectedSymbols: ["resolveSymbol"],
	},
	{
		id: "context-edge-resolution",
		api: "context",
		query: "how does resolve edges work in TsExtractor resolveEdgesForFile",
		expectedSymbols: ["resolveEdges", "TsExtractor", "resolveEdgesForFile"],
	},
	{
		id: "context-indexing",
		api: "context",
		query: "how does Indexer indexAll indexing work",
		expectedSymbols: ["Indexer", "indexAll"],
	},
	{
		id: "context-symbol-lookup",
		api: "context",
		query: "how does resolveSymbol symbol lookup work",
		expectedSymbols: ["resolveSymbol", "SymbolLookupResult"],
	},
	{
		id: "context-fts-normalization",
		api: "context",
		query: "how does toFtsMatchQuery exact name boost normalize FTS queries",
		expectedSymbols: ["toFtsMatchQuery", "toExactNameBoostToken"],
	},
	{
		id: "context-file-scanning",
		api: "context",
		query: "how does BunGlobScanner scan project files",
		expectedSymbols: ["BunGlobScanner", "scan"],
	},
];
