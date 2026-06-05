import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Astrograph, AstrographCore, Watcher } from "@astrograph/core";
import { MissingIndexError, ProjectSession, findProjectRoot } from "../project";

describe("MCP project session", () => {
	test("finds the nearest .astrograph directory", async () => {
		const root = await mkdtemp(`${tmpdir()}/astrograph-mcp-root-`);
		try {
			await mkdir(`${root}/.astrograph`, { recursive: true });
			await mkdir(`${root}/src/deep`, { recursive: true });

			expect(findProjectRoot(`${root}/src/deep`)).toBe(root);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("throws a clear init error when no index exists", async () => {
		const root = await mkdtemp(`${tmpdir()}/astrograph-mcp-no-index-`);
		try {
			const session = new ProjectSession({
				cwd: root,
				open: async () => fakeGraph() as Astrograph,
			});

			await expect(session.getGraph()).rejects.toBeInstanceOf(
				MissingIndexError,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("runs connect-time sync once on first open", async () => {
		const root = await mkdtemp(`${tmpdir()}/astrograph-mcp-sync-`);
		let syncCount = 0;
		let openedRoot = "";
		try {
			await mkdir(`${root}/.astrograph`, { recursive: true });
			const graph = fakeGraph({
				sync: async () => {
					syncCount += 1;
					return { added: [], modified: [], removed: [] };
				},
			});
			const session = new ProjectSession({
				cwd: root,
				open: async (projectRoot) => {
					openedRoot = projectRoot;
					return graph as Astrograph;
				},
			});

			await session.getGraph();
			await session.getGraph();

			expect(openedRoot).toBe(root);
			expect(syncCount).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("no-watch sessions do not subscribe a watcher but still reconcile on open", async () => {
		const root = await mkdtemp(`${tmpdir()}/astrograph-mcp-no-watch-`);
		let syncCount = 0;
		let watchCount = 0;
		try {
			await mkdir(`${root}/.astrograph`, { recursive: true });
			const watcher: Watcher = {
				watch: () => {
					watchCount += 1;
					return { close() {} };
				},
			};
			const graph = fakeGraph({
				sync: async () => {
					syncCount += 1;
					return { added: [], modified: [], removed: [] };
				},
			});
			const session = new ProjectSession({
				cwd: root,
				watch: false,
				watcher,
				open: async () => graph as Astrograph,
			});

			await session.getGraph();

			expect(syncCount).toBe(1);
			expect(watchCount).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("active daemon makes MCP read-only: no reconcile and no watcher", async () => {
		const root = await mkdtemp(`${tmpdir()}/astrograph-mcp-daemon-`);
		let syncCount = 0;
		let watchCount = 0;
		try {
			await mkdir(`${root}/.astrograph`, { recursive: true });
			await writeFile(
				`${root}/.astrograph/daemon.json`,
				JSON.stringify({
					pid: process.pid,
					startedAt: 1,
					root,
					mode: "watch",
				}),
				"utf8",
			);
			const watcher: Watcher = {
				watch: () => {
					watchCount += 1;
					return { close() {} };
				},
			};
			const graph = fakeGraph({
				sync: async () => {
					syncCount += 1;
					return { added: [], modified: [], removed: [] };
				},
			});
			const session = new ProjectSession({
				cwd: root,
				watch: true,
				watcher,
				open: async () => graph as Astrograph,
			});

			await session.getGraph();

			expect(syncCount).toBe(0);
			expect(watchCount).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

function fakeGraph(overrides: Partial<AstrographCore> = {}): AstrographCore {
	return {
		search: async () => ({ data: [], meta: meta() }),
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
			meta: meta(),
		}),
		trace: async () => ({ data: { found: false, hops: [] }, meta: meta() }),
		callers: async () => ({ data: [], meta: meta() }),
		callees: async () => ({ data: [], meta: meta() }),
		impact: async () => ({ data: [], meta: meta() }),
		getNode: async () => {
			throw new Error("not implemented");
		},
		explore: async () => ({
			data: { files: [], relationshipMap: [] },
			meta: meta(),
		}),
		getFiles: async () => ({
			data: { format: "flat", entries: [] },
			meta: meta(),
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
			meta: meta(),
		}),
		indexAll: async () => {},
		sync: async () => ({ added: [], modified: [], removed: [] }),
		syncFiles: async () => ({ added: [], modified: [], removed: [] }),
		close: () => {},
		...overrides,
	};
}

function meta() {
	return {
		coverage: { total: 0, resolved: 0, parsed: 0, pending: 0 },
		partial: false,
	};
}
