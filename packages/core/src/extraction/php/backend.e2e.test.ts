import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openProject } from "../../adapters/bun/project";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

const PHP_SOURCE = `<?php

namespace App;

class Greeter
{
    public string $name;

    public function greet(): string
    {
        return $this->name;
    }
}

function shout(string $msg): string
{
    return strtoupper($msg);
}
`;

describe("PHP backend: end-to-end via openProject (tree-sitter only, no enricher)", () => {
	test("indexes real symbol nodes, not just a lone file node", async () => {
		const root = await makeTempProject();
		await writeProjectFile(root, "src/Greeter.php", PHP_SOURCE);

		const indexer = await openProject(root, {
			dbPath: ":memory:",
			now: () => 100,
		});
		try {
			await indexer.indexAll();

			const nodes = indexer.queries.getNodesByFile("src/Greeter.php");
			const kinds = nodes.map((n) => n.kind);

			expect(kinds).toContain("file");
			// Real symbol nodes, not just a lone file node.
			expect(nodes.length).toBeGreaterThan(1);
			expect(kinds).toContain("class");
			expect(kinds).toContain("function");

			const file = indexer.queries.getFile("src/Greeter.php");
			expect(file).toBeDefined();
			// PHP has no enricher: Pass A alone is the final answer for the file.
			expect(file?.state).toBe("resolved");
			expect(file?.nodeCount).toBe(nodes.length);
		} finally {
			indexer.close();
		}
	});

	test("provenance canary: at least one node carries metadata.provenance === 'tree-sitter'", async () => {
		const root = await makeTempProject();
		await writeProjectFile(root, "src/Greeter.php", PHP_SOURCE);

		const indexer = await openProject(root, {
			dbPath: ":memory:",
			now: () => 100,
		});
		try {
			await indexer.indexAll();

			const nodes = indexer.queries.getNodesByFile("src/Greeter.php");
			expect(nodes.some((n) => n.metadata?.provenance === "tree-sitter")).toBe(
				true,
			);
		} finally {
			indexer.close();
		}
	});

	test("contains edges resolve with high confidence and tree-sitter provenance, no calls/imports invented", async () => {
		const root = await makeTempProject();
		await writeProjectFile(root, "src/Greeter.php", PHP_SOURCE);

		const indexer = await openProject(root, {
			dbPath: ":memory:",
			now: () => 100,
		});
		try {
			await indexer.indexAll();

			const nodes = indexer.queries.getNodesByFile("src/Greeter.php");
			const fileNode = nodes.find((n) => n.kind === "file");
			expect(fileNode).toBeDefined();

			const edges = indexer.queries.getEdgesBySource(fileNode!.id);
			expect(edges.length).toBeGreaterThan(0);
			for (const edge of edges) {
				expect(edge.kind).toBe("contains");
				expect(edge.resolutionState).toBe("resolved");
				expect(edge.confidence).toBe("high");
				expect(edge.provenance).toBe("tree-sitter");
			}
		} finally {
			indexer.close();
		}
	});

	test("sync re-indexes a changed PHP file and keeps it resolved", async () => {
		const root = await makeTempProject();
		await writeProjectFile(root, "src/Greeter.php", PHP_SOURCE);

		const indexer = await openProject(root, {
			dbPath: ":memory:",
			now: () => 100,
		});
		try {
			await indexer.indexAll();

			await writeProjectFile(
				root,
				"src/Greeter.php",
				`${PHP_SOURCE}\nfunction extra(): void {}\n`,
			);
			const result = await indexer.sync();
			expect(result.modified).toEqual(["src/Greeter.php"]);

			const file = indexer.queries.getFile("src/Greeter.php");
			expect(file?.state).toBe("resolved");
			const nodes = indexer.queries.getNodesByFile("src/Greeter.php");
			expect(nodes.map((n) => n.name)).toContain("extra");
		} finally {
			indexer.close();
		}
	});

	test("callers on a PHP symbol states that the php backend produces no call edges", async () => {
		const root = await makeTempProject();
		await writeProjectFile(root, "src/Greeter.php", PHP_SOURCE);

		const graph = await openProject(root, {
			dbPath: ":memory:",
			now: () => 100,
		});
		try {
			await graph.indexAll();

			const callers = await graph.callers({ symbol: "greet" });
			expect(callers.data).toEqual([]);
			expect(callers.meta.notes).toContain(
				"php backend produces no call edges",
			);
			expect(callers.meta.partial).toBe(true);

			const callees = await graph.callees({ symbol: "greet" });
			expect(callees.data).toEqual([]);
			expect(callees.meta.notes).toContain(
				"php backend produces no call edges",
			);

			const impact = await graph.impact({ symbol: "greet" });
			expect(impact.data).toEqual([]);
			expect(
				impact.meta.notes?.some((note) =>
					note.startsWith("php backend produces no"),
				),
			).toBe(true);
		} finally {
			graph.close();
		}
	});
});

async function makeTempProject(): Promise<string> {
	const root = await mkdtemp(`${tmpdir()}/astrograph-php-e2e-`);
	tempRoots.push(root);
	return root;
}

async function writeProjectFile(
	root: string,
	relPath: string,
	content: string,
): Promise<void> {
	const fullPath = `${root}/${relPath}`;
	const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
	await mkdir(dir, { recursive: true });
	await writeFile(fullPath, content, "utf8");
}
