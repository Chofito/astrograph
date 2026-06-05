import { describe, expect, test } from "bun:test";
import { makeNodeId, type MakeNodeIdInput } from "./ids";
import type { Hasher } from "./types";

const hasher: Hasher = {
	hash(content) {
		return String(Bun.hash(content));
	},
};

describe("makeNodeId", () => {
	test("is deterministic for the same declaration identity", () => {
		const input: MakeNodeIdInput = {
			project: "root",
			filePath: "src/auth/service.ts",
			kind: "method",
			qualifiedName: "src/auth/service.ts::AuthService.login",
			locator: "signature:email-password",
		};

		expect(makeNodeId(input, hasher)).toBe(makeNodeId(input, hasher));
	});

	test("normalizes file path separators", () => {
		const unixPath = makeNodeId(
			{
				project: "root",
				filePath: "src/auth/service.ts",
				kind: "function",
				qualifiedName: "src/auth/service.ts::login",
			},
			hasher,
		);

		const windowsPath = makeNodeId(
			{
				project: "root",
				filePath: "src\\auth\\service.ts",
				kind: "function",
				qualifiedName: "src/auth/service.ts::login",
			},
			hasher,
		);

		expect(windowsPath).toBe(unixPath);
	});

	test("does not collide across a small declaration set", () => {
		const declarations: MakeNodeIdInput[] = [
			{
				project: "root",
				filePath: "src/a.ts",
				kind: "function",
				qualifiedName: "src/a.ts::run",
			},
			{
				project: "root",
				filePath: "src/a.ts",
				kind: "function",
				qualifiedName: "src/a.ts::run",
				locator: "overload:1",
			},
			{
				project: "root",
				filePath: "src/a.ts",
				kind: "function",
				qualifiedName: "src/a.ts::run",
				locator: "overload:2",
			},
			{
				project: "root",
				filePath: "src/a.ts",
				kind: "class",
				qualifiedName: "src/a.ts::run",
			},
			{
				project: "root",
				filePath: "src/a.ts",
				kind: "function",
				qualifiedName: "src/a.ts::outer.<callback>",
				locator: "outer:callback:0",
			},
			{
				project: "root",
				filePath: "src/b.ts",
				kind: "function",
				qualifiedName: "src/b.ts::run",
			},
		];

		const ids = declarations.map((input) => makeNodeId(input, hasher));
		expect(new Set(ids).size).toBe(declarations.length);
	});
});
