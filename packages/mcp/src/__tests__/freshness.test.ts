import { describe, expect, test } from "bun:test";
import {
	FreshnessManager,
	type AstrographCore,
	type ToolResult,
	type WatchEvent,
} from "@astrograph/core";

describe("MCP freshness manager", () => {
	test("on-demand guard syncs pending files before the next tool result", async () => {
		const synced: WatchEvent[][] = [];
		const manager = new FreshnessManager({
			root: "/repo",
			graph: fakeGraph({
				syncFiles: async (events) => {
					synced.push(events);
					return {
						added: [],
						modified: events.map((event) => event.path),
						removed: [],
					};
				},
			}),
			debounceMs: 10_000,
		});

		try {
			manager.recordEvent({ type: "change", path: "/repo/src/fresh.ts" });
			await manager.beforeQuery();

			const result = manager.decorateResult(resultWithMeta("fresh"));
			expect(synced).toEqual([[{ type: "change", path: "src/fresh.ts" }]]);
			expect(result.meta.partial).toBe(false);
			expect(result.meta.pendingFiles).toBeUndefined();
		} finally {
			manager.close();
		}
	});

	test("pending files are surfaced in the banner while waiting for debounce", () => {
		const manager = new FreshnessManager({
			root: "/repo",
			graph: fakeGraph(),
			debounceMs: 10_000,
		});

		try {
			manager.recordEvent({ type: "change", path: "/repo/src/pending.ts" });
			const result = manager.decorateResult(resultWithMeta("stale"));

			expect(result.meta.partial).toBe(true);
			expect(result.meta.pendingFiles).toEqual(["src/pending.ts"]);
		} finally {
			manager.close();
		}
	});

	test("watcher-unavailable path marks answers partial without full-tree restat", async () => {
		let fullSyncs = 0;
		const manager = new FreshnessManager({
			root: "/repo",
			graph: fakeGraph({
				sync: async () => {
					fullSyncs += 1;
					return { added: [], modified: [], removed: [] };
				},
			}),
		});

		try {
			manager.markUnavailable();
			await manager.beforeQuery();
			const result = manager.decorateResult(resultWithMeta("answer"));

			expect(fullSyncs).toBe(0);
			expect(result.meta.partial).toBe(true);
			expect(result.meta.notes).toEqual([
				"watcher unavailable; freshness depends on explicit sync or pending events",
			]);
		} finally {
			manager.close();
		}
	});

	test("tool guard cancels the debounce path so one pending batch writes once", async () => {
		let syncCount = 0;
		const manager = new FreshnessManager({
			root: "/repo",
			graph: fakeGraph({
				syncFiles: async () => {
					syncCount += 1;
					return { added: [], modified: ["src/a.ts"], removed: [] };
				},
			}),
			debounceMs: 10_000,
		});

		try {
			manager.recordEvent({ type: "change", path: "/repo/src/a.ts" });
			await Promise.all([manager.beforeQuery(), manager.beforeQuery()]);

			expect(syncCount).toBe(1);
			expect(manager.pendingFiles()).toEqual([]);
		} finally {
			manager.close();
		}
	});

	test("reports sync lifecycle callbacks for a debounced batch", async () => {
		const started: WatchEvent[][] = [];
		const completed: string[][] = [];
		const manager = new FreshnessManager({
			root: "/repo",
			graph: fakeGraph({
				syncFiles: async (events) => ({
					added: [],
					modified: events.map((event) => event.path),
					removed: [],
				}),
			}),
			debounceMs: 10_000,
			onSyncStart: (events) => started.push(events),
			onSyncComplete: (_events, result) => completed.push(result.modified),
		});

		try {
			manager.recordEvent({ type: "change", path: "/repo/src/a.ts" });
			manager.recordEvent({ type: "change", path: "/repo/src/b.ts" });
			await manager.beforeQuery();

			expect(started).toEqual([
				[
					{ type: "change", path: "src/a.ts" },
					{ type: "change", path: "src/b.ts" },
				],
			]);
			expect(completed).toEqual([["src/a.ts", "src/b.ts"]]);
		} finally {
			manager.close();
		}
	});
});

function resultWithMeta(data: string): ToolResult<string> {
	return {
		data,
		meta: {
			coverage: { total: 1, resolved: 1, parsed: 0, pending: 0 },
			partial: false,
		},
	};
}

function fakeGraph(overrides: Partial<AstrographCore> = {}): AstrographCore {
	return {
		search: async () => ({ data: [], meta: resultWithMeta("").meta }),
		context: async () => ({
			data: {
				entryPoints: [],
				subgraph: { nodes: [], edges: [] },
				codeBlocks: [],
				inclusionReasons: {},
				relatedFiles: [],
				stats: {
					nodeCount: 0,
					edgeCount: 0,
					fileCount: 0,
					codeBlockCount: 0,
					totalCodeChars: 0,
				},
			},
			meta: resultWithMeta("").meta,
		}),
		trace: async () => ({
			data: { found: false, hops: [] },
			meta: resultWithMeta("").meta,
		}),
		callers: async () => ({ data: [], meta: resultWithMeta("").meta }),
		callees: async () => ({ data: [], meta: resultWithMeta("").meta }),
		impact: async () => ({ data: [], meta: resultWithMeta("").meta }),
		getNode: async () => {
			throw new Error("not implemented");
		},
		explore: async () => ({
			data: { files: [], relationshipMap: [] },
			meta: resultWithMeta("").meta,
		}),
		getFiles: async () => ({
			data: { format: "flat", entries: [] },
			meta: resultWithMeta("").meta,
		}),
		getStats: async () => ({
			data: {
				nodeCount: 0,
				edgeCount: 0,
				fileCount: 0,
				nodesByKind: {},
				edgesByKind: {},
				filesByLanguage: {},
				coverage: { total: 0, resolved: 0, parsed: 0, pending: 0 },
				dbSizeBytes: 0,
				lastUpdated: 0,
				backend: "sqlite",
				journalMode: "wal",
			},
			meta: resultWithMeta("").meta,
		}),
		indexAll: async () => {},
		sync: async () => ({ added: [], modified: [], removed: [] }),
		syncFiles: async () => ({ added: [], modified: [], removed: [] }),
		close: () => {},
		...overrides,
	};
}
