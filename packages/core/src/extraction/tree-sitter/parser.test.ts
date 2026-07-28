import { beforeAll, describe, expect, test } from "bun:test";
import type { Edge, Hasher, Node, PassAResult } from "../../types";
import { initTreeSitter, loadGrammars } from "./grammars";
import { TreeSitterParser } from "./parser";

const HASHER: Hasher = { hash: (s) => String(Bun.hash(s)) };

beforeAll(async () => {
	await initTreeSitter();
	await loadGrammars(["typescript", "php"]);
});

function parse(filePath: string, source: string): PassAResult {
	const parser = new TreeSitterParser({
		hasher: HASHER,
		now: () => 100,
		project: "root",
	});
	return parser.extractNodes(filePath, source);
}

/** Every node id reachable from the file node by following `contains` edges. */
function reachableFromFile(nodes: Node[], edges: Edge[]): Set<string> {
	const fileNode = nodes.find((n) => n.kind === "file");
	if (!fileNode) return new Set();

	const children = new Map<string, string[]>();
	for (const edge of edges) {
		if (edge.kind !== "contains" || edge.target === null) continue;
		const list = children.get(edge.source) ?? [];
		list.push(edge.target);
		children.set(edge.source, list);
	}

	const seen = new Set<string>([fileNode.id]);
	const queue = [fileNode.id];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const childId of children.get(current) ?? []) {
			if (!seen.has(childId)) {
				seen.add(childId);
				queue.push(childId);
			}
		}
	}
	return seen;
}

const TS_SOURCE = `
export class Greeter {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet(): string {
    return this.name;
  }
}

export function shout(msg: string): string {
  return msg.toUpperCase();
}
`;

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

describe("TreeSitterParser: Pass A contains edges", () => {
	test("ts: every emitted symbol is reachable from the file node", () => {
		const result = parse("greeter.ts", TS_SOURCE);
		expect(result.errors).toEqual([]);

		const symbolCount = result.nodes.filter((n) => n.kind !== "file").length;
		expect(symbolCount).toBeGreaterThan(0);

		const reachable = reachableFromFile(result.nodes, result.edges);
		for (const node of result.nodes) {
			expect(reachable.has(node.id)).toBe(true);
		}
	});

	test("php: every emitted symbol is reachable from the file node", () => {
		const result = parse("Greeter.php", PHP_SOURCE);
		expect(result.errors.filter((e) => e.severity === "error")).toEqual([]);

		const symbolCount = result.nodes.filter((n) => n.kind !== "file").length;
		expect(symbolCount).toBeGreaterThan(0);

		const reachable = reachableFromFile(result.nodes, result.edges);
		for (const node of result.nodes) {
			expect(reachable.has(node.id)).toBe(true);
		}
	});

	test("contains edges never dangle: every source/target is an emitted node id", () => {
		const result = parse("greeter.ts", TS_SOURCE);
		const ids = new Set(result.nodes.map((n) => n.id));
		for (const edge of result.edges) {
			expect(ids.has(edge.source)).toBe(true);
			expect(edge.target === null || ids.has(edge.target)).toBe(true);
		}
	});
});

describe("TreeSitterParser: provenance", () => {
	test("every Pass A node and contains edge is stamped tree-sitter", () => {
		const result = parse("greeter.ts", TS_SOURCE);
		for (const node of result.nodes) {
			expect(node.metadata?.provenance).toBe("tree-sitter");
		}
		for (const edge of result.edges) {
			expect(edge.kind).toBe("contains");
			expect(edge.provenance).toBe("tree-sitter");
			expect(edge.resolutionState).toBe("resolved");
			expect(edge.confidence).toBe("high");
		}
	});
});

describe("TreeSitterParser: unsupported / unavailable grammar", () => {
	test("a path with no known extension yields a file-only result with an error", () => {
		const result = parse("README", "hello");
		expect(result.nodes.map((n) => n.kind)).toEqual(["file"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.code).toBe("TREE_SITTER_UNAVAILABLE");
	});
});
