import { describe, expect, test } from "bun:test";
import type { Node, NodeKind, Range } from "../types";
import { reconcileNodes } from "./reconcile";

const RANGE: Range = { startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 };

function makeNode(id: string, overrides: Partial<Node> = {}): Node {
	return {
		id,
		project: "root",
		kind: "function" as NodeKind,
		name: id,
		qualifiedName: `file.ts::${id}`,
		filePath: "file.ts",
		language: "typescript",
		range: RANGE,
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

describe("reconcileNodes", () => {
	test("empty inputs produce an empty plan and zeroed stats", () => {
		const plan = reconcileNodes([], []);
		expect(plan.update).toEqual([]);
		expect(plan.insert).toEqual([]);
		expect(plan.delete).toEqual([]);
		expect(plan.errors).toEqual([]);
		expect(plan.stats).toEqual({ matched: 0, added: 0, dropped: 0 });
	});

	test("matched/added/dropped arithmetic over overlapping id sets", () => {
		const a = makeNode("a");
		const b = makeNode("b");
		const c = makeNode("c");
		const aEnriched = makeNode("a", { name: "a-enriched" });

		const plan = reconcileNodes([a, b], [aEnriched, c]);

		expect(plan.stats).toEqual({ matched: 1, added: 1, dropped: 1 });
		expect(plan.update.map((n) => n.id)).toEqual(["a"]);
		expect(plan.insert.map((n) => n.id)).toEqual(["c"]);
		expect(plan.delete).toEqual([]);
	});

	test("matched nodes keep their id and take the enricher's content", () => {
		const passA = makeNode("shared", { name: "pass-a-name" });
		const enriched = makeNode("shared", { name: "enriched-name" });

		const plan = reconcileNodes([passA], [enriched]);

		expect(plan.update).toHaveLength(1);
		expect(plan.update[0]!.id).toBe("shared");
		expect(plan.update[0]!.name).toBe("enriched-name");
	});

	test("an enricher returning nothing warns per Pass A node but does not delete them", () => {
		const a = makeNode("a", {
			kind: "class",
			qualifiedName: "file.ts::A",
			range: { startLine: 5, endLine: 5, startColumn: 0, endColumn: 0 },
		});
		const b = makeNode("b");

		const plan = reconcileNodes([a, b], []);

		expect(plan.stats).toEqual({ matched: 0, added: 0, dropped: 2 });
		expect(plan.update).toEqual([]);
		expect(plan.insert).toEqual([]);
		expect(plan.delete).toEqual([]);
		expect(plan.errors).toHaveLength(2);
		for (const error of plan.errors) {
			expect(error.code).toBe("PASS_A_NODE_DROPPED");
			expect(error.severity).toBe("warning");
		}
		const errorForA = plan.errors.find((e) => e.message.includes("A"));
		expect(errorForA?.line).toBe(5);
	});

	test("no Pass A nodes: every enricher node is an insert, nothing dropped", () => {
		const c = makeNode("c");
		const d = makeNode("d");

		const plan = reconcileNodes([], [c, d]);

		expect(plan.stats).toEqual({ matched: 0, added: 2, dropped: 0 });
		expect(plan.insert.map((n) => n.id).sort()).toEqual(["c", "d"]);
		expect(plan.delete).toEqual([]);
	});

	test("ids present on both sides are neither inserted nor deleted", () => {
		const shared = makeNode("shared");
		const plan = reconcileNodes([shared], [makeNode("shared")]);
		expect(plan.insert).toEqual([]);
		expect(plan.delete).toEqual([]);
		expect(plan.update.map((n) => n.id)).toEqual(["shared"]);
	});

	test("provenance option stamps metadata.provenance on update and insert, leaving the input untouched", () => {
		const passA = makeNode("shared");
		const enrichedShared = makeNode("shared", { metadata: { foo: "bar" } });
		const enrichedNew = makeNode("new");

		const plan = reconcileNodes([passA], [enrichedShared, enrichedNew], {
			provenance: "ts-compiler",
		});

		const updated = plan.update.find((n) => n.id === "shared")!;
		expect(updated.metadata).toEqual({ foo: "bar", provenance: "ts-compiler" });
		// original enricher node object must not be mutated in place
		expect(enrichedShared.metadata).toEqual({ foo: "bar" });

		const inserted = plan.insert.find((n) => n.id === "new")!;
		expect(inserted.metadata).toEqual({ provenance: "ts-compiler" });
	});

	test("without a provenance option, enricher nodes pass through unchanged", () => {
		const enriched = makeNode("only", { metadata: { foo: "bar" } });
		const plan = reconcileNodes([], [enriched]);
		expect(plan.insert[0]).toBe(enriched);
	});

	test("dropped-node errors use the options.filePath override when given", () => {
		const a = makeNode("a", { filePath: "actual.ts" });
		const plan = reconcileNodes([a], [], { filePath: "reported.ts" });
		expect(plan.errors[0]!.filePath).toBe("reported.ts");
	});

	test("dropped-node errors fall back to the node's own filePath", () => {
		const a = makeNode("a", { filePath: "actual.ts" });
		const plan = reconcileNodes([a], []);
		expect(plan.errors[0]!.filePath).toBe("actual.ts");
	});
});
