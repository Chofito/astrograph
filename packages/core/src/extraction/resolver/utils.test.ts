import ts from "typescript";
import { describe, expect, test } from "bun:test";
import {
	compareEdges,
	compareStr,
	hasTsIgnoreDirective,
	isOverloadSet,
	pickDeclaration,
} from "./utils";
import type { Edge } from "../../types";

function sourceFile(source: string, name = "t.ts"): ts.SourceFile {
	return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
}

function firstFunctionDecl(source: string): ts.FunctionDeclaration {
	const sf = sourceFile(source);
	let found: ts.FunctionDeclaration | undefined;
	ts.forEachChild(sf, (node) => {
		if (found === undefined && ts.isFunctionDeclaration(node)) found = node;
	});
	if (found === undefined) throw new Error("no function declaration");
	return found;
}

function topLevelDecls(source: string): ts.Declaration[] {
	const sf = sourceFile(source);
	const decls: ts.Declaration[] = [];
	ts.forEachChild(sf, (node) => {
		if (ts.isFunctionDeclaration(node) || ts.isModuleDeclaration(node)) {
			decls.push(node);
		}
	});
	return decls;
}

function overloadDecls(source: string, name: string): ts.Declaration[] {
	const sf = sourceFile(source);
	const decls: ts.Declaration[] = [];
	ts.forEachChild(sf, (node) => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
			decls.push(node);
		}
	});
	return decls;
}

describe("resolver/utils pickDeclaration", () => {
	test("returns the implementation body for overload sets", () => {
		const source = `
function f(x: number): number;
function f(x: string): string;
function f(x: number | string) { return x; }
`;
		const decls = overloadDecls(source, "f");
		expect(isOverloadSet(decls)).toBe(true);
		const picked = pickDeclaration(decls);
		expect(picked).toBeDefined();
		expect(ts.isFunctionDeclaration(picked!)).toBe(true);
		expect((picked as ts.FunctionDeclaration).body).toBeDefined();
	});

	test("overload set is not treated as ambiguous merged declarations", () => {
		const source = `
function f(x: number): number;
function f(x: string): string;
function f(x: number | string) { return x; }
`;
		const decls = overloadDecls(source, "f");
		expect(decls.length).toBeGreaterThan(1);
		expect(isOverloadSet(decls)).toBe(true);
	});
});

describe("resolver/utils isOverloadSet vs merged declarations", () => {
	test("function + namespace merge is not an overload set", () => {
		const source = `
function merged() { return 1; }
namespace merged { export const tag = "ns"; }
export function readTag() { return merged.tag; }
`;
		const decls = topLevelDecls(source);
		expect(decls.length).toBeGreaterThan(1);
		expect(isOverloadSet(decls)).toBe(false);
	});

	test("pickDeclaration still prefers the implementation for overloads", () => {
		const source = `
function g(a: number): number;
function g(a: string): string;
function g(a: number | string) { return a; }
`;
		const decls = overloadDecls(source, "g");
		const picked = pickDeclaration(decls);
		expect(ts.isFunctionDeclaration(picked!)).toBe(true);
		expect((picked as ts.FunctionDeclaration).body).toBeDefined();
	});
});

describe("resolver/utils hasTsIgnoreDirective", () => {
	test("detects @ts-ignore in leading comments", () => {
		const source = `
// @ts-ignore
function risky() { return null as unknown as string; }
`;
		const decl = firstFunctionDecl(source);
		expect(hasTsIgnoreDirective(decl, sourceFile(source))).toBe(true);
	});

	test("returns false without ignore directives", () => {
		const source = `function safe() { return 1; }`;
		const decl = firstFunctionDecl(source);
		expect(hasTsIgnoreDirective(decl, sourceFile(source))).toBe(false);
	});
});

describe("resolver/utils compareEdges", () => {
	test("sorts by source, kind, target, then line", () => {
		const edges: Edge[] = [
			{
				source: "b",
				target: "t",
				kind: "calls",
				resolutionState: "resolved",
				confidence: "high",
				provenance: "ts-compiler",
				line: 2,
			},
			{
				source: "a",
				target: "t",
				kind: "calls",
				resolutionState: "resolved",
				confidence: "high",
				provenance: "ts-compiler",
				line: 1,
			},
		];
		const sorted = [...edges].sort(compareEdges);
		expect(sorted[0]!.source).toBe("a");
		expect(sorted[1]!.source).toBe("b");
	});

	test("compareStr orders lexicographically", () => {
		expect(compareStr("a", "b")).toBeLessThan(0);
		expect(compareStr("b", "a")).toBeGreaterThan(0);
		expect(compareStr("x", "x")).toBe(0);
	});
});
