import type { EvalCase } from "./types";

/**
 * Cases are written against this repository itself (the default `repoPath`).
 *
 * Expectations for the graph-shaped APIs (callers / callees / impact / node)
 * were derived by reading the actual call sites in `packages/core/src` and
 * cross-checking them against the live index — never by restating the queried
 * symbol, which only scores under recursion.
 */
export const EVAL_CASES: EvalCase[] = [
	{
		id: "search-node-id",
		api: "search",
		query: "makeNodeId",
		kind: "function",
		expectedSymbols: [
			{
				name: "makeNodeId",
				file: "packages/core/src/ids.ts",
				kind: "function",
			},
		],
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
		expectedSymbols: [
			{ name: "GraphQueries", file: "query/graph-queries.ts", kind: "class" },
		],
	},
	{
		id: "search-open-project",
		api: "search",
		query: "open project",
		expectedSymbols: [
			{
				name: "openProject",
				file: "adapters/bun/project.ts",
				kind: "function",
			},
		],
	},
	{
		id: "search-symbol-lookup",
		api: "search",
		query: "resolve symbol",
		expectedSymbols: [
			{ name: "resolveSymbol", file: "graph/symbol-lookup.ts" },
		],
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
		expectedSymbols: [
			{ name: "Indexer", file: "core/src/indexer.ts", kind: "class" },
			{ name: "indexAll", file: "core/src/indexer.ts" },
		],
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
		expectedSymbols: [
			{ name: "BunGlobScanner", file: "adapters/bun/glob.ts", kind: "class" },
			{ name: "scan", file: "adapters/bun/glob.ts" },
		],
	},
	{
		id: "callers-make-node-id",
		api: "callers",
		query: "makeNodeId",
		why: "Enclosing symbols of every makeNodeId call site in packages/core/src.",
		expectedSymbols: [
			{ name: "computeNodeIdentity", file: "extraction/shared/identity.ts" },
			{ name: "makeNode", file: "extraction/tree-sitter/parser.ts" },
			{ name: "makeFileNode", file: "extraction/typescript/extractor.ts" },
			{ name: "buildNode", file: "extraction/typescript/extractor.ts" },
			{ name: "extractNodes", file: "extraction/stub/php-backend.ts" },
		],
	},
	{
		id: "callees-open-project",
		api: "callees",
		query: "openProject",
		why: "Functions called and classes instantiated inside openProject's body.",
		expectedSymbols: [
			{ name: "normalizePath", file: "adapters/bun/project.ts" },
			{ name: "initTreeSitter", file: "tree-sitter/grammars.ts" },
			{ name: "loadGrammars", file: "tree-sitter/grammars.ts" },
			{ name: "runMigrations", file: "db/migrations.ts" },
			{ name: "createDefaultRegistry", file: "extraction/registry.ts" },
			{ name: "Indexer", file: "core/src/indexer.ts", kind: "class" },
			{ name: "GraphQueries", file: "query/graph-queries.ts", kind: "class" },
			{ name: "Astrograph", file: "core/src/astrograph.ts", kind: "class" },
		],
	},
	{
		id: "impact-to-node-ref",
		api: "impact",
		query: "toNodeRef",
		depth: 2,
		why: "Blast radius of the NodeRef projection helper: every query surface that shapes output.",
		expectedSymbols: [
			{ name: "search", file: "db/queries.ts", kind: "method" },
			{ name: "callers", file: "query/graph-queries.ts", kind: "method" },
			{ name: "callees", file: "query/graph-queries.ts", kind: "method" },
			{ name: "impact", file: "query/graph-queries.ts", kind: "method" },
			{ name: "trace", file: "query/graph-queries.ts", kind: "method" },
			{ name: "getNode", file: "core/src/astrograph.ts", kind: "method" },
		],
	},
	{
		id: "impact-build-meta",
		api: "impact",
		query: "buildMeta",
		depth: 2,
		why: "Coverage metadata reaches every tool through GraphQueries.meta.",
		expectedSymbols: [
			{ name: "meta", file: "query/graph-queries.ts", kind: "method" },
			{ name: "explore", file: "query/graph-queries.ts", kind: "method" },
			{ name: "getFiles", file: "query/graph-queries.ts", kind: "method" },
			{ name: "getStats", file: "query/graph-queries.ts", kind: "method" },
		],
	},
	{
		id: "impact-make-node-id",
		api: "impact",
		query: "makeNodeId",
		depth: 2,
		why: "Changing node identity reaches both extractor front-ends at depth 2.",
		expectedSymbols: [
			{ name: "computeNodeIdentity", file: "extraction/shared/identity.ts" },
			{ name: "makeNode", file: "extraction/tree-sitter/parser.ts" },
			{ name: "buildNode", file: "extraction/typescript/extractor.ts" },
			{ name: "extractNodes", file: "extraction/tree-sitter/parser.ts" },
			{
				name: "handleClassDeclaration",
				file: "extraction/typescript/extractor.ts",
			},
		],
	},
	{
		id: "node-resolve-symbol",
		api: "node",
		query: "resolveSymbol",
		why: "getNode must return the symbol plus its caller/callee previews.",
		expectedSymbols: [
			{
				name: "resolveSymbol",
				file: "graph/symbol-lookup.ts",
				kind: "function",
			},
			{
				name: "resolveOrThrow",
				file: "query/graph-queries.ts",
				kind: "method",
			},
			{ name: "findNodesByName", file: "db/queries.ts", kind: "method" },
		],
	},
	{
		id: "explore-symbol-lookup",
		api: "explore",
		query: "resolveSymbol SymbolLookupResult",
		why: "Explore is file-oriented; expectations are file nodes, not symbols.",
		expectedSymbols: [{ name: "symbol-lookup.ts", kind: "file" }],
	},
	{
		id: "files-query-layer",
		api: "files",
		query: "packages/core/src/query",
		why: "The query layer's file list is fixed and cheap to assert exactly.",
		expectedSymbols: [
			{ name: "graph-queries.ts", kind: "file" },
			{ name: "meta.ts", kind: "file" },
			{ name: "code-blocks.ts", kind: "file" },
		],
	},
	{
		id: "trace-class-decl-to-node-id",
		api: "trace",
		query: "handleClassDeclaration",
		traceTo: "makeNodeId",
		why: "Two-hop path handleClassDeclaration -> buildNode -> makeNodeId. TraceOutput.hops carries the *source* of each edge, so the destination itself is never a hop; `found` is what proves it was reached.",
		expectedSymbols: [
			{ name: "handleClassDeclaration", file: "typescript/extractor.ts" },
			{ name: "buildNode", file: "typescript/extractor.ts" },
		],
	},
	{
		id: "trace-resolve-to-find-nodes",
		api: "trace",
		query: "resolveOrThrow",
		traceTo: "findNodesByName",
		why: "resolveOrThrow -> resolveSymbol -> findNodesByName; crosses a module boundary.",
		expectedSymbols: [
			{ name: "resolveOrThrow", file: "query/graph-queries.ts" },
			{ name: "resolveSymbol", file: "graph/symbol-lookup.ts" },
		],
	},
	{
		id: "trace-no-path-leaf-to-entry",
		api: "trace",
		query: "makeNodeId",
		traceTo: "openProject",
		expectPath: false,
		why: "makeNodeId is a leaf; no calls/references path can reach openProject. Guards against a graph that invents paths, and scores the fallback endpoints payload.",
		expectedSymbols: [
			{ name: "makeNodeId", file: "packages/core/src/ids.ts" },
			{ name: "openProject", file: "adapters/bun/project.ts" },
		],
	},
];
