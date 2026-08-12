import { describe, expect, test } from "bun:test";
import type { Hasher, LanguageBackend, PassAResult } from "../types";
import {
	createDefaultRegistry,
	grammarsForRegistry,
	LanguageRegistry,
} from "./registry";

const HASHER: Hasher = { hash: (s) => String(Bun.hash(s)) };

const NOOP_PASS_A: PassAResult = { nodes: [], edges: [], errors: [] };

function fakeBackend(id: string, extensions: string[]): LanguageBackend {
	return {
		id,
		languages: [id],
		extensions,
		parser: { extractNodes: () => NOOP_PASS_A },
		capabilities: { edgeKinds: ["contains"] },
		versionKeys: () => ({ version: "1" }),
	};
}

describe("LanguageRegistry", () => {
	test("backendForPath routes by extension, case-insensitively", () => {
		const ts = fakeBackend("typescript", [".ts", ".tsx"]);
		const php = fakeBackend("php", [".php"]);
		const registry = new LanguageRegistry([ts, php]);

		expect(registry.backendForPath("src/a.ts")).toBe(ts);
		expect(registry.backendForPath("src/a.TS")).toBe(ts);
		expect(registry.backendForPath("src/a.php")).toBe(php);
	});

	test("backendForPath returns undefined for unknown extensions and extensionless paths", () => {
		const registry = new LanguageRegistry([fakeBackend("typescript", [".ts"])]);
		expect(registry.backendForPath("src/a.unknown")).toBeUndefined();
		expect(registry.backendForPath("Makefile")).toBeUndefined();
	});

	test("allExtensions merges every backend's extensions, deduped and sorted", () => {
		const ts = fakeBackend("typescript", [".tsx", ".ts"]);
		const php = fakeBackend("php", [".php"]);
		const registry = new LanguageRegistry([ts, php]);
		expect(registry.allExtensions()).toEqual([".php", ".ts", ".tsx"]);
	});

	test("list returns every registered backend in registration order", () => {
		const ts = fakeBackend("typescript", [".ts"]);
		const php = fakeBackend("php", [".php"]);
		const registry = new LanguageRegistry([ts, php]);
		expect(registry.list()).toEqual([ts, php]);
	});

	test("backendById looks up by id", () => {
		const php = fakeBackend("php", [".php"]);
		const registry = new LanguageRegistry([php]);
		expect(registry.backendById("php")).toBe(php);
		expect(registry.backendById("missing")).toBeUndefined();
	});
});

describe("createDefaultRegistry", () => {
	test("registers typescript and php by default", () => {
		const registry = createDefaultRegistry({ hasher: HASHER });
		const ids = registry
			.list()
			.map((b) => b.id)
			.sort();
		expect(ids).toEqual(["php", "typescript"]);
		expect(registry.backendForPath("a.ts")?.id).toBe("typescript");
		expect(registry.backendForPath("a.php")?.id).toBe("php");
	});

	test("a disabled backend drops out via AstrographConfig.backends", () => {
		const registry = createDefaultRegistry({
			hasher: HASHER,
			config: { backends: { php: { enabled: false } } },
		});
		expect(registry.list().map((b) => b.id)).toEqual(["typescript"]);
		expect(registry.backendForPath("a.php")).toBeUndefined();
		expect(registry.allExtensions()).not.toContain(".php");
	});

	test("backends.<id>.enricher: false keeps the backend but drops its enricher", () => {
		const registry = createDefaultRegistry({
			hasher: HASHER,
			config: {
				backends: {
					typescript: { enricher: false },
					php: { enricher: false },
				},
			},
		});
		expect(registry.backendById("typescript")?.enricher).toBeUndefined();
		expect(registry.backendById("php")?.enricher).toBeUndefined();
		expect(registry.backendById("php")?.capabilities.edgeKinds).toEqual([
			"contains",
		]);
	});

	test("php ships a name-resolution enricher that can emit extends/implements", () => {
		const registry = createDefaultRegistry({ hasher: HASHER });
		const php = registry.backendById("php");
		expect(php?.enricher?.mode).toBe("complement");
		expect(php?.capabilities.edgeKinds).toEqual([
			"contains",
			"extends",
			"implements",
			"imports",
			"type_of",
			"returns",
			"calls",
			"instantiates",
		]);
	});
});

describe("grammarsForRegistry", () => {
	test("lists tree-sitter langs needed by all backends, deduped and sorted", () => {
		const registry = createDefaultRegistry({ hasher: HASHER });
		expect(grammarsForRegistry(registry)).toEqual([
			"javascript",
			"jsx",
			"php",
			"tsx",
			"typescript",
		]);
	});

	test("an empty registry needs no grammars", () => {
		expect(grammarsForRegistry(new LanguageRegistry([]))).toEqual([]);
	});
});
