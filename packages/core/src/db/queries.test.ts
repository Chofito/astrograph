import { afterEach, describe, expect, test } from "bun:test";
import { openSqliteStorage } from "../adapters/bun/sqlite";
import { runMigrations } from "./migrations";
import { QueryBuilder } from "./queries";
import type { Edge, FileRecord, Node, StorageAdapter } from "../types";

let openDbs: StorageAdapter[] = [];

afterEach(() => {
	for (const db of openDbs) db.close();
	openDbs = [];
});

describe("core storage", () => {
	test("round-trips files, nodes, and edges through SQLite", () => {
		const query = createQueryBuilder();
		const file = makeFile({
			path: "src/auth.ts",
			state: "resolved",
			nodeCount: 2,
		});
		const source = makeNode({
			id: "node:auth-file",
			kind: "file",
			name: "auth.ts",
		});
		const target = makeNode({
			id: "node:login",
			kind: "function",
			name: "login",
			qualifiedName: "src/auth.ts::login",
			signature: "function login(): void",
			docstring: "Logs a user in.",
			decorators: ["trace"],
			typeParameters: ["TUser"],
			metadata: { role: "entrypoint" },
		});

		query.upsertFile(file);
		query.upsertNode(source);
		query.upsertNode(target);
		const edge = query.upsertEdge(
			makeEdge({
				source: source.id,
				target: target.id,
				targetName: "login",
				metadata: { via: "unit-test" },
			}),
		);

		expect(query.getFile(file.path)).toEqual(file);
		expect(query.getNode(source.id)).toEqual(source);
		expect(query.getNode(target.id)).toEqual(target);
		expect(query.getEdge(edge.id ?? -1)).toEqual(edge);
	});

	test("cascades edges when deleting nodes for a file", () => {
		const query = createQueryBuilder();
		const caller = makeNode({
			id: "node:caller",
			filePath: "src/caller.ts",
			qualifiedName: "src/caller.ts::caller",
			name: "caller",
		});
		const callee = makeNode({
			id: "node:callee",
			filePath: "src/callee.ts",
			qualifiedName: "src/callee.ts::callee",
			name: "callee",
		});

		query.upsertFile(
			makeFile({ path: "src/caller.ts", state: "resolved", nodeCount: 1 }),
		);
		query.upsertFile(
			makeFile({ path: "src/callee.ts", state: "resolved", nodeCount: 1 }),
		);
		query.upsertNode(caller);
		query.upsertNode(callee);
		query.upsertEdge(makeEdge({ source: caller.id, target: callee.id }));

		query.deleteByFile("src/callee.ts");

		expect(query.getNode(callee.id)).toBeUndefined();
		expect(query.getAllEdges()).toEqual([]);
		expect(query.getDanglingEdges()).toEqual([]);
	});

	test("FTS search returns expected ids and coverage counts are correct", () => {
		const query = createQueryBuilder();
		const alpha = makeNode({
			id: "node:alpha",
			name: "AlphaService",
			qualifiedName: "src/alpha.ts::AlphaService",
			kind: "class",
			filePath: "src/alpha.ts",
		});
		const beta = makeNode({
			id: "node:beta",
			name: "BetaService",
			qualifiedName: "src/beta.ts::BetaService",
			kind: "class",
			filePath: "src/beta.ts",
			isGenerated: true,
		});

		query.upsertFile(
			makeFile({ path: "src/alpha.ts", state: "resolved", nodeCount: 1 }),
		);
		query.upsertFile(
			makeFile({ path: "src/beta.ts", state: "parsed", nodeCount: 1 }),
		);
		query.upsertFile(
			makeFile({ path: "src/gamma.ts", state: "pending", nodeCount: 0 }),
		);
		query.upsertNode(alpha);
		query.upsertNode(beta);

		expect(
			query.search({ query: "AlphaService" }).map((result) => result.node.id),
		).toEqual(["node:alpha"]);
		expect(query.search({ query: "BetaService" })).toEqual([]);
		expect(
			query
				.search({ query: "BetaService", includeGenerated: true })
				.map((result) => result.node.id),
		).toEqual(["node:beta"]);
		expect(query.getCoverage()).toEqual({
			total: 3,
			resolved: 1,
			parsed: 1,
			pending: 1,
		});
	});

	test("FTS search accepts natural language and punctuation deterministically", () => {
		const query = createQueryBuilder();
		const hook = makeNode({
			id: "node:use-add-to-cart",
			name: "useAddToCart",
			qualifiedName: "src/cart.ts::useAddToCart",
			kind: "function",
			filePath: "src/cart.ts",
		});

		query.upsertFile(
			makeFile({ path: "src/cart.ts", state: "resolved", nodeCount: 1 }),
		);
		query.upsertNode(hook);

		const natural = query.search({ query: "how does useAddToCart work" });
		const repeat = query.search({ query: "how does useAddToCart work" });

		expect(natural.map((result) => result.node.id)).toEqual([
			"node:use-add-to-cart",
		]);
		expect(() =>
			query.search({ query: 'how does "useAddToCart()" work? (cart:item)' }),
		).not.toThrow();
		expect(
			query.search({ query: "useAddToCart" }).map((result) => result.node.id),
		).toEqual(["node:use-add-to-cart"]);
		expect(repeat).toEqual(natural);
	});

	test("FTS search ranks name matches above docstring-only matches", () => {
		const query = createQueryBuilder();
		const nameMatch = makeNode({
			id: "node:name-match",
			name: "useAddToCart",
			qualifiedName: "src/cart.ts::useAddToCart",
			kind: "function",
			filePath: "src/cart.ts",
		});
		const docMatch = makeNode({
			id: "node:doc-match",
			name: "cartDocs",
			qualifiedName: "src/docs.ts::cartDocs",
			kind: "function",
			filePath: "src/docs.ts",
			docstring: "Documents useAddToCart behavior for agents.",
		});
		const subTokenMatch = makeNode({
			id: "node:sub-token-match",
			name: "addToCart",
			qualifiedName: "src/add.ts::addToCart",
			kind: "function",
			filePath: "src/add.ts",
		});

		query.upsertFile(
			makeFile({ path: "src/cart.ts", state: "resolved", nodeCount: 1 }),
		);
		query.upsertFile(
			makeFile({ path: "src/docs.ts", state: "resolved", nodeCount: 1 }),
		);
		query.upsertFile(
			makeFile({ path: "src/add.ts", state: "resolved", nodeCount: 1 }),
		);
		query.upsertNode(docMatch);
		query.upsertNode(subTokenMatch);
		query.upsertNode(nameMatch);

		expect(
			query.search({ query: "useAddToCart" }).map((result) => result.node.id),
		).toEqual(["node:name-match", "node:sub-token-match", "node:doc-match"]);
	});

	test("sync-support lookups are deterministic", () => {
		const query = createQueryBuilder();
		const source = makeNode({
			id: "node:source",
			name: "source",
			qualifiedName: "src/a.ts::source",
		});
		const target = makeNode({
			id: "node:target",
			name: "target",
			qualifiedName: "src/b.ts::target",
		});

		query.upsertNode(source);
		query.upsertNode(target);
		query.upsertEdge(
			makeEdge({
				source: source.id,
				target: target.id,
				kind: "calls",
				line: 10,
			}),
		);
		query.upsertEdge(
			makeEdge({
				source: source.id,
				target: null,
				targetName: "LaterSymbol",
				kind: "references",
				resolutionState: "unresolved",
				confidence: "low",
				line: 20,
			}),
		);

		expect(
			query.getEdgesByTarget(target.id).map((edge) => edge.source),
		).toEqual([source.id]);
		expect(
			query
				.getEdgesByResolutionStateAndTargetName("unresolved", "LaterSymbol")
				.map((edge) => edge.targetName),
		).toEqual(["LaterSymbol"]);
	});
});

function createQueryBuilder(): QueryBuilder {
	const db = openSqliteStorage(":memory:");
	openDbs.push(db);
	runMigrations(db, { now: () => 1 });
	return new QueryBuilder(db);
}

function makeNode(overrides: Partial<Node>): Node {
	return {
		id: "node:default",
		project: "root",
		kind: "function",
		name: "defaultName",
		qualifiedName: "src/default.ts::defaultName",
		filePath: "src/default.ts",
		language: "typescript",
		range: {
			startLine: 1,
			endLine: 5,
			startColumn: 0,
			endColumn: 1,
		},
		isExported: false,
		isAsync: false,
		isStatic: false,
		isAbstract: false,
		isExternal: false,
		isGenerated: false,
		isTest: false,
		updatedAt: 100,
		...overrides,
	};
}

function makeEdge(overrides: Partial<Edge>): Edge {
	return {
		source: "node:source",
		target: "node:target",
		kind: "calls",
		resolutionState: "resolved",
		confidence: "high",
		provenance: "ts-compiler",
		line: 1,
		col: 0,
		...overrides,
	};
}

function makeFile(overrides: Partial<FileRecord>): FileRecord {
	return {
		path: "src/default.ts",
		project: "root",
		contentHash: "hash:default",
		language: "typescript",
		size: 100,
		modifiedAt: 10,
		indexedAt: 20,
		nodeCount: 1,
		state: "pending",
		...overrides,
	};
}
