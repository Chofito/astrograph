import { describe, expect, test } from "bun:test";
import type {
	Edge,
	ExtractionError,
	FileRecord,
	Hasher,
	Node,
	ToolMeta,
} from "../types";
import {
	canonicalize,
	digest,
	EDGE_FIELD_STABILITY,
	EXTRACTION_ERROR_FIELD_STABILITY,
	FILE_FIELD_STABILITY,
	NODE_FIELD_STABILITY,
	normalize,
	normalizeEnvelope,
	normalizeIndex,
	ORACLE_SCHEMA_VERSION,
	TOOL_META_FIELD_STABILITY,
	volatileFields,
} from "./normalize";

describe("normalize", () => {
	test("drops volatile fields, strips absolute roots, and sorts deterministically", () => {
		const nodes: Node[] = [
			makeNode({
				id: "node:b",
				filePath: "/repo/src/b.ts",
				qualifiedName: "/repo/src/b.ts::b",
				range: { startLine: 5, endLine: 6, startColumn: 0, endColumn: 1 },
				updatedAt: 200,
			}),
			makeNode({
				id: "node:a",
				filePath: "/repo/src/a.ts",
				qualifiedName: "/repo/src/a.ts::a",
				range: { startLine: 1, endLine: 2, startColumn: 0, endColumn: 1 },
				updatedAt: 100,
			}),
		];
		const edges: Edge[] = [
			makeEdge({
				id: 2,
				source: "node:b",
				target: "node:a",
				kind: "references",
				line: 2,
			}),
			makeEdge({
				id: 1,
				source: "node:a",
				target: "node:b",
				kind: "calls",
				line: 1,
			}),
		];

		const graph = normalize({ nodes, edges }, { rootPath: "/repo" });

		expect(graph.nodes.map((node) => node.filePath)).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
		expect(graph.nodes.map((node) => "updatedAt" in node)).toEqual([
			false,
			false,
		]);
		expect(graph.edges.map((edge) => edge.source)).toEqual([
			"node:a",
			"node:b",
		]);
		expect(graph.edges.map((edge) => "id" in edge)).toEqual([false, false]);
	});
});

function makeNode(overrides: Partial<Node> = {}): Node {
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

function makeEdge(overrides: Partial<Edge> = {}): Edge {
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

/* -------------------------------------------------------------------------- */
/* AG-301: the oracle contract                                                */
/* -------------------------------------------------------------------------- */

const HASHER: Hasher = { hash: (content) => String(Bun.hash(content)) };

function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
	return {
		path: "src/a.ts",
		project: "root",
		contentHash: "hash-a",
		language: "typescript",
		size: 42,
		modifiedAt: 111,
		indexedAt: 222,
		nodeCount: 1,
		state: "resolved",
		...overrides,
	};
}

function source(files: FileRecord[], nodes: Node[], edges: Edge[]) {
	return {
		getAllFiles: () => files,
		getAllNodes: () => nodes,
		getAllEdges: () => edges,
	};
}

describe("every field has an explicit stability rule", () => {
	test("a fully populated node keeps every retained field", () => {
		const node = makeNode({
			signature: "(a: string) => void",
			docstring: "docs",
			visibility: "public",
			decorators: ["@dec"],
			typeParameters: ["T"],
			metadata: { provenance: "ts-compiler" },
		});

		const [normalized] = normalize({ nodes: [node], edges: [] }).nodes;
		for (const [field, rule] of Object.entries(NODE_FIELD_STABILITY)) {
			if (rule === "retained") {
				expect(normalized).toHaveProperty(field);
			} else {
				expect(field in (normalized ?? {})).toBe(false);
			}
		}
	});

	test("a fully populated edge keeps every retained field", () => {
		const edge = makeEdge({
			id: 9,
			targetName: "name",
			metadata: { reason: "receiver unknown" },
		});

		const [normalized] = normalize({ nodes: [], edges: [edge] }).edges;
		for (const [field, rule] of Object.entries(EDGE_FIELD_STABILITY)) {
			if (rule === "retained") {
				expect(normalized).toHaveProperty(field);
			} else {
				expect(field in (normalized ?? {})).toBe(false);
			}
		}
	});

	test("a fully populated file record keeps every retained field", () => {
		const file = makeFile({
			errors: [
				{ message: "boom", severity: "error", code: "PARSE_ERROR", line: 3 },
			],
		});

		const [normalized] = normalizeIndex(source([file], [], [])).files;
		for (const [field, rule] of Object.entries(FILE_FIELD_STABILITY)) {
			if (rule === "retained") {
				expect(normalized).toHaveProperty(field);
			} else {
				expect(field in (normalized ?? {})).toBe(false);
			}
		}
	});

	test("a fully populated extraction error keeps every retained field", () => {
		const error: ExtractionError = {
			message: "boom",
			filePath: "src/a.ts",
			line: 3,
			column: 4,
			severity: "warning",
			code: "PARSE_ERROR",
		};

		const [file] = normalizeIndex(
			source([makeFile({ errors: [error] })], [], []),
		).files;
		const [normalized] = file?.errors ?? [];
		for (const [field, rule] of Object.entries(
			EXTRACTION_ERROR_FIELD_STABILITY,
		)) {
			if (rule === "retained") {
				expect(normalized).toHaveProperty(field);
			} else {
				expect(field in (normalized ?? {})).toBe(false);
			}
		}
	});

	test("every ToolMeta field survives, and adding one has to be classified", () => {
		// The envelope's table is enforcement, not documentation: a new `ToolMeta`
		// field that nobody classified would be missing from every recorded
		// envelope, and no test would notice.
		const meta: ToolMeta = {
			coverage: { total: 2, resolved: 1, parsed: 1, pending: 0 },
			partial: true,
			domain: "global_reverse",
			reasons: [{ kind: "coverage_incomplete", detail: "one file is pending" }],
			evidence: { counts: [], samples: [], truncated: false },
			pendingFiles: ["/root/src/a.ts"],
			notes: ["one file is pending"],
		};

		const normalized = normalizeEnvelope(meta, { rootPath: "/root" });
		for (const [field, rule] of Object.entries(TOOL_META_FIELD_STABILITY)) {
			expect(rule).toBe("retained");
			expect(normalized).toHaveProperty(field);
		}
		// The one transformation the envelope does allow.
		expect(normalized.pendingFiles).toEqual(["src/a.ts"]);
	});

	test("every removed field states a reason", () => {
		const removed = volatileFields();
		expect(removed.map((entry) => entry.field)).toEqual([
			"Edge.id",
			"FileRecord.indexedAt",
			"FileRecord.modifiedAt",
			"Node.updatedAt",
		]);
		for (const entry of removed) {
			expect(entry.reason.length).toBeGreaterThan(20);
		}
	});
});

describe("semantically different graphs never compare equal", () => {
	test("two node_modules paths under the same root stay apart", () => {
		// Regression: the `/node_modules/` branch ran *before* the root was
		// removed and sliced at the first occurrence, so in a monorepo
		// `<root>/packages/a/node_modules/x` and `<root>/packages/b/node_modules/x`
		// both became `node_modules/x`. Two distinct external declarations, one
		// snapshot.
		const root = "/tmp/project";
		const inPackage = (pkg: string) =>
			normalize(
				{
					nodes: [
						makeNode({
							id: `id-${pkg}`,
							filePath: `${root}/packages/${pkg}/node_modules/dep/index.d.ts`,
							qualifiedName: `${root}/packages/${pkg}/node_modules/dep/index.d.ts::dep`,
						}),
					],
					edges: [],
				},
				{ rootPath: root },
			);

		expect(inPackage("a").nodes[0]?.filePath).toBe(
			"packages/a/node_modules/dep/index.d.ts",
		);
		expect(inPackage("a")).not.toEqual(inPackage("b"));
	});

	test("a path outside the root is still reduced to its package tail", () => {
		// The fallback the fix must preserve: an absolute path that escapes the
		// project names somebody's home directory, and only the package-relative
		// tail is the same on the next machine.
		const [node] = normalize(
			{
				nodes: [
					makeNode({
						filePath: "/home/someone/.cache/node_modules/dep/index.d.ts",
						qualifiedName:
							"/home/someone/.cache/node_modules/dep/index.d.ts::dep",
					}),
				],
				edges: [],
			},
			{ rootPath: "/tmp/project" },
		).nodes;
		expect(node?.filePath).toBe("node_modules/dep/index.d.ts");
	});

	test("a sibling directory sharing the root's prefix survives stripping", () => {
		// Regression: `stripRoot` was an unanchored `replaceAll`, so with a root
		// of `/tmp/ag` the message "in /tmp/agent/x.ts" became "in ent/x.ts" —
		// the same snapshot as a diagnostic that really said "in ent/x.ts".
		const withMessage = (message: string) =>
			normalizeIndex(
				source(
					[
						makeFile({
							errors: [
								{
									message,
									filePath: "src/a.ts",
									severity: "warning",
									code: "PARSE_ERROR",
								},
							],
						}),
					],
					[],
					[],
				),
				{ rootPath: "/tmp/ag" },
			);

		expect(withMessage("in /tmp/agent/x.ts").files[0]?.errors[0]?.message).toBe(
			"in /tmp/agent/x.ts",
		);
		expect(withMessage("in /tmp/agent/x.ts")).not.toEqual(
			withMessage("in ent/x.ts"),
		);
		// And the root itself is still removed, including when punctuation rather
		// than a slash ends it.
		expect(
			withMessage("failed at /tmp/ag: why").files[0]?.errors[0]?.message,
		).toBe("failed at : why");
	});

	test("edges differing only in metadata get a deterministic order", () => {
		// `compareEdges` had no unique final key, so two edges alike in every
		// compared field but differing in `metadata` were tied and their order
		// came from SQLite. Feeding the same pair in both orders must produce one
		// snapshot.
		const first = makeEdge({
			resolutionState: "ambiguous",
			metadata: { candidates: ["a", "b"] },
		});
		const second = makeEdge({
			resolutionState: "ambiguous",
			metadata: { candidates: ["c", "d"] },
		});

		const forward = normalize({ nodes: [], edges: [first, second] });
		const backward = normalize({ nodes: [], edges: [second, first] });
		expect(forward).toEqual(backward);
		// And they are still two distinguishable edges, not one.
		expect(forward.edges.length).toBe(2);
		expect(forward.edges[0]?.metadata).not.toEqual(forward.edges[1]?.metadata);
	});

	test("undefined inside metadata is normalized away, on purpose", () => {
		// The documented boundary: SQLite stores `metadata` as JSON and
		// `JSON.stringify` omits `undefined` object values, so the two inputs
		// below are the same persisted fact. Preserving the difference would make
		// an in-memory graph diverge from the identical graph read back out.
		const explicit = normalize({
			nodes: [],
			edges: [makeEdge({ metadata: { candidate: undefined, count: 1 } })],
		});
		const absent = normalize({
			nodes: [],
			edges: [makeEdge({ metadata: { count: 1 } })],
		});
		expect(explicit).toEqual(absent);

		// `null`, which SQLite *can* store, is preserved and still distinguishes.
		const nulled = normalize({
			nodes: [],
			edges: [makeEdge({ metadata: { candidate: null, count: 1 } })],
		});
		expect(nulled).not.toEqual(absent);
	});

	test("edges differing only in confidence stay distinguishable", () => {
		const strong = normalize({
			nodes: [],
			edges: [makeEdge({ confidence: "high" })],
		});
		const weak = normalize({
			nodes: [],
			edges: [makeEdge({ confidence: "low" })],
		});
		expect(strong).not.toEqual(weak);
	});

	test("edges differing only in resolution state stay distinguishable", () => {
		const resolved = normalize({ nodes: [], edges: [makeEdge()] });
		const unresolved = normalize({
			nodes: [],
			edges: [
				makeEdge({
					target: null,
					targetName: "node:target",
					resolutionState: "unresolved",
				}),
			],
		});
		expect(resolved).not.toEqual(unresolved);
	});

	test("edges differing only in provenance stay distinguishable", () => {
		expect(
			normalize({
				nodes: [],
				edges: [makeEdge({ provenance: "tree-sitter" })],
			}),
		).not.toEqual(
			normalize({
				nodes: [],
				edges: [makeEdge({ provenance: "ts-compiler" })],
			}),
		);
	});

	test("files differing only in state or diagnostics stay distinguishable", () => {
		const clean = normalizeIndex(source([makeFile()], [], []));
		const parsed = normalizeIndex(
			source([makeFile({ state: "parsed" })], [], []),
		);
		const gapped = normalizeIndex(
			source(
				[
					makeFile({
						errors: [
							{
								message: "grammar missing",
								severity: "warning",
								code: "TREE_SITTER_GRAMMAR_MISSING",
							},
						],
					}),
				],
				[],
				[],
			),
		);

		expect(clean).not.toEqual(parsed);
		expect(clean).not.toEqual(gapped);
	});

	test("external nodes are retained, not normalized away", () => {
		const external = makeNode({
			id: "node:external",
			isExternal: true,
			filePath: "/tmp/x/node_modules/lib/index.d.ts",
		});
		const graph = normalize({ nodes: [external], edges: [] });
		expect(graph.nodes.length).toBe(1);
		expect(graph.nodes[0]?.isExternal).toBe(true);
		// The machine-specific prefix goes; the package path stays.
		expect(graph.nodes[0]?.filePath).toBe("node_modules/lib/index.d.ts");
	});
});

describe("ordering is a total order", () => {
	test("edges tied on source, kind, target and line still order deterministically", () => {
		// Before AG-301 those four fields were the whole comparator, so a tie fell
		// through to SQLite row order and two identical indexes could normalize
		// differently. The new keys are appended after `line`, never interleaved,
		// so an existing golden's order is untouched.
		const a = makeEdge({ col: 1, confidence: "high" });
		const b = makeEdge({ col: 1, confidence: "low" });
		const c = makeEdge({ col: 2, confidence: "high" });

		const forward = normalize({ nodes: [], edges: [a, b, c] }).edges;
		const backward = normalize({ nodes: [], edges: [c, b, a] }).edges;
		expect(forward).toEqual(backward);
		expect(forward.map((edge) => [edge.col, edge.confidence])).toEqual([
			[1, "high"],
			[1, "low"],
			[2, "high"],
		]);
	});

	test("appended tie-breakers never reorder edges the old keys separated", () => {
		// The regression this guards: putting `targetName` before `line` reordered
		// pairs that differ in both, which silently rewrites every committed
		// golden.
		const earlyLineLateName = makeEdge({ line: 1, targetName: "zzz" });
		const lateLineEarlyName = makeEdge({ line: 2, targetName: "aaa" });

		const edges = normalize({
			nodes: [],
			edges: [lateLineEarlyName, earlyLineLateName],
		}).edges;
		expect(edges.map((edge) => edge.line)).toEqual([1, 2]);
	});

	test("appended tie-breakers never reorder nodes the old keys separated", () => {
		const earlyLineLateColumn = makeNode({
			id: "node:a",
			range: { startLine: 1, endLine: 1, startColumn: 9, endColumn: 9 },
		});
		const lateLineEarlyColumn = makeNode({
			id: "node:b",
			range: { startLine: 2, endLine: 2, startColumn: 0, endColumn: 0 },
		});

		const nodes = normalize({
			nodes: [lateLineEarlyColumn, earlyLineLateColumn],
			edges: [],
		}).nodes;
		expect(nodes.map((node) => node.range.startLine)).toEqual([1, 2]);
	});

	test("nodes tied on file, line, kind and qualified name order by id", () => {
		const first = makeNode({ id: "node:aaa", name: "same" });
		const second = makeNode({ id: "node:bbb", name: "same" });

		const forward = normalize({ nodes: [first, second], edges: [] }).nodes;
		const backward = normalize({ nodes: [second, first], edges: [] }).nodes;
		expect(forward).toEqual(backward);
		expect(forward.map((node) => node.id)).toEqual(["node:aaa", "node:bbb"]);
	});

	test("diagnostics on one file order deterministically", () => {
		const errors: ExtractionError[] = [
			{ message: "b", severity: "warning", code: "PARSE_ERROR", line: 2 },
			{ message: "a", severity: "warning", code: "PARSE_ERROR", line: 1 },
			{ message: "c", severity: "error", code: "RESOLVE_ERROR" },
		];
		const forward = normalizeIndex(source([makeFile({ errors })], [], []));
		const backward = normalizeIndex(
			source([makeFile({ errors: [...errors].reverse() })], [], []),
		);
		expect(forward).toEqual(backward);
		expect(forward.files[0]?.errors.map((e) => e.message)).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	test("files order by path regardless of storage order", () => {
		const files = [
			makeFile({ path: "src/z.ts" }),
			makeFile({ path: "src/a.ts" }),
		];
		const index = normalizeIndex(source(files, [], []));
		expect(index.files.map((file) => file.path)).toEqual([
			"src/a.ts",
			"src/z.ts",
		]);
	});
});

describe("only machine-volatile paths are removed from diagnostics", () => {
	test("an absolute project path is stripped from the error path and message", () => {
		const index = normalizeIndex(
			source(
				[
					makeFile({
						path: "/tmp/run-1/src/a.ts",
						errors: [
							{
								message: "Cannot find module at /tmp/run-1/src/missing.ts",
								filePath: "/tmp/run-1/src/a.ts",
								severity: "error",
								code: "RESOLVE_ERROR",
							},
						],
					}),
				],
				[],
				[],
			),
			{ rootPath: "/tmp/run-1" },
		);

		expect(index.files[0]?.path).toBe("src/a.ts");
		expect(index.files[0]?.errors[0]?.filePath).toBe("src/a.ts");
		expect(index.files[0]?.errors[0]?.message).toBe(
			"Cannot find module at src/missing.ts",
		);
	});

	test("two runs in different temp directories normalize equal", () => {
		const forRoot = (root: string) =>
			normalizeIndex(
				source(
					[
						makeFile({
							path: `${root}/src/a.ts`,
							errors: [
								{
									message: `parse failed in ${root}/src/a.ts`,
									filePath: `${root}/src/a.ts`,
									severity: "error",
									code: "PARSE_ERROR",
								},
							],
						}),
					],
					[],
					[],
				),
				{ rootPath: root },
			);

		expect(forRoot("/tmp/run-1")).toEqual(forRoot("/tmp/run-2"));
	});

	test("a path outside the project is left alone", () => {
		// It is the same on the next run, so removing it would hide a real
		// difference rather than a volatile one.
		const index = normalizeIndex(
			source(
				[
					makeFile({
						errors: [
							{
								message: "lib error at /usr/lib/ts/lib.d.ts",
								severity: "error",
								code: "RESOLVE_ERROR",
							},
						],
					}),
				],
				[],
				[],
			),
			{ rootPath: "/tmp/run-1" },
		);
		expect(index.files[0]?.errors[0]?.message).toBe(
			"lib error at /usr/lib/ts/lib.d.ts",
		);
	});

	test("the diagnostic itself is never dropped to make runs agree", () => {
		const withError = normalizeIndex(
			source(
				[
					makeFile({
						errors: [
							{ message: "boom", severity: "error", code: "PARSE_ERROR" },
						],
					}),
				],
				[],
				[],
			),
		);
		const without = normalizeIndex(source([makeFile()], [], []));
		expect(withError).not.toEqual(without);
	});
});

describe("query envelopes are a separate snapshot", () => {
	const meta: ToolMeta = {
		coverage: { total: 2, resolved: 1, parsed: 0, pending: 1 },
		partial: true,
		domain: "global_reverse",
		reasons: [
			{
				kind: "coverage_incomplete",
				detail: "1 of 2 files under /tmp/run-1 have not finished resolving.",
				files: ["/tmp/run-1/src/z.ts", "/tmp/run-1/src/a.ts"],
			},
		],
		pendingFiles: ["/tmp/run-1/src/z.ts", "/tmp/run-1/src/a.ts"],
		notes: ["1 of 2 files under /tmp/run-1 have not finished resolving."],
	};

	test("the envelope is not part of the graph snapshot", () => {
		const index = normalizeIndex(source([makeFile()], [], []));
		expect(Object.keys(index).sort()).toEqual(["edges", "files", "nodes"]);
	});

	test("paths inside the envelope are root-normalized and sorted", () => {
		const envelope = normalizeEnvelope(meta, { rootPath: "/tmp/run-1" });
		expect(envelope.pendingFiles).toEqual(["src/a.ts", "src/z.ts"]);
		expect(envelope.reasons?.[0]?.files).toEqual(["src/a.ts", "src/z.ts"]);
		expect(envelope.notes?.[0]).toBe(
			"1 of 2 files under  have not finished resolving.",
		);
	});

	test("nothing about the claim is dropped", () => {
		const envelope = normalizeEnvelope(meta);
		expect(envelope.partial).toBe(true);
		expect(envelope.domain).toBe("global_reverse");
		expect(envelope.coverage).toEqual(meta.coverage);
		expect(envelope.reasons?.[0]?.kind).toBe("coverage_incomplete");
	});

	test("two runs in different temp directories produce the same envelope", () => {
		const one = normalizeEnvelope(meta, { rootPath: "/tmp/run-1" });
		const two = normalizeEnvelope(
			{
				...meta,
				reasons: meta.reasons?.map((reason) => ({
					...reason,
					detail: reason.detail.replace("/tmp/run-1", "/tmp/run-2"),
					files: reason.files?.map((f) =>
						f.replace("/tmp/run-1", "/tmp/run-2"),
					),
				})),
				pendingFiles: meta.pendingFiles?.map((f) =>
					f.replace("/tmp/run-1", "/tmp/run-2"),
				),
				notes: meta.notes?.map((n) => n.replace("/tmp/run-1", "/tmp/run-2")),
			},
			{ rootPath: "/tmp/run-2" },
		);
		expect(one).toEqual(two);
	});
});

describe("digests use the same normalization as committed goldens", () => {
	test("key order in the input does not change the digest", () => {
		expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
	});

	test("array order does change it, because order is part of the oracle", () => {
		expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
	});

	test("the same normalized index digests identically", () => {
		const index = normalizeIndex(source([makeFile()], [makeNode({})], []));
		expect(digest(index, HASHER)).toBe(digest(index, HASHER));
	});

	test("a semantic difference changes the digest", () => {
		const before = normalizeIndex(source([makeFile()], [], []));
		const after = normalizeIndex(
			source([makeFile({ state: "parsed" })], [], []),
		);
		expect(digest(before, HASHER)).not.toBe(digest(after, HASHER));
	});

	test("the schema version participates, so goldens cannot cross versions", () => {
		expect(digest({ a: 1 }, HASHER)).toBe(
			HASHER.hash(`${ORACLE_SCHEMA_VERSION}\u001f{"a":1}`),
		);
	});
});
