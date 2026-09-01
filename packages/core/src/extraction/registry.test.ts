import { describe, expect, test } from "bun:test";
import type { Enricher, Hasher, LanguageBackend, PassAResult } from "../types";
import {
	BackendRegistrationError,
	createDefaultRegistry,
	EXTRACTION_CONTRACT_VERSION,
	grammarsForRegistry,
	LanguageRegistry,
	shippedBackendExtensionOwners,
} from "./registry";

const HASHER: Hasher = { hash: (s) => String(Bun.hash(s)) };

const NOOP_PASS_A: PassAResult = { nodes: [], edges: [], errors: [] };

function fakeBackend(
	id: string,
	extensions: string[],
	overrides: Partial<LanguageBackend> = {},
): LanguageBackend {
	return {
		id,
		languages: [id],
		extensions,
		parser: { extractNodes: () => NOOP_PASS_A },
		capabilities: { edgeKinds: ["contains"] },
		versionKeys: () => ({ version: "1" }),
		...overrides,
	};
}

const STUB_ENRICHER: Enricher = {
	mode: "complement",
	id: "stub",
	provenance: "synthesized:stub",
	resolveEdges: () => ({ edges: [], errors: [], externalNodes: [] }),
};

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
		// PHP enrichment is name resolution over the same tree-sitter parse, so
		// its rows must not be stamped with the TypeScript compiler's provenance.
		expect(php?.enricher?.provenance).toBe("tree-sitter");
		expect(registry.backendById("typescript")?.enricher?.provenance).toBe(
			"ts-compiler",
		);
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

describe("LanguageRegistry registration validation", () => {
	test("two backends with the same id are rejected", () => {
		expect(
			() =>
				new LanguageRegistry([
					fakeBackend("php", [".php"]),
					fakeBackend("php", [".php5"]),
				]),
		).toThrow(BackendRegistrationError);
	});

	test("two backends claiming the same extension are rejected, case-insensitively", () => {
		expect(
			() =>
				new LanguageRegistry([
					fakeBackend("typescript", [".ts"]),
					fakeBackend("other", [".TS"]),
				]),
		).toThrow(/claimed by both "typescript" and "other"/);
	});

	test("a backend claiming no extensions is rejected", () => {
		expect(() => new LanguageRegistry([fakeBackend("empty", [])])).toThrow(
			/claims no extensions/,
		);
	});

	test("an extension without a leading dot is rejected", () => {
		expect(() => new LanguageRegistry([fakeBackend("bad", ["ts"])])).toThrow(
			/invalid extension "ts"/,
		);
	});

	test("capabilities must include contains, because Pass A always runs", () => {
		expect(
			() =>
				new LanguageRegistry([
					fakeBackend("nocontains", [".x"], {
						enricher: STUB_ENRICHER,
						capabilities: { edgeKinds: ["calls"] },
					}),
				]),
		).toThrow(/must declare "contains"/);
	});

	test("a Pass-A-only backend may not advertise enricher-only edge kinds", () => {
		expect(
			() =>
				new LanguageRegistry([
					fakeBackend("overclaim", [".x"], {
						capabilities: { edgeKinds: ["contains", "calls"] },
					}),
				]),
		).toThrow(
			/Pass-A-only backend "overclaim" declares enricher-only edge kinds: calls/,
		);
	});

	test("a Pass-A-only backend declaring exactly contains is accepted", () => {
		const registry = new LanguageRegistry([fakeBackend("passa", [".x"])]);
		expect(registry.backendById("passa")?.enricher).toBeUndefined();
	});

	test("duplicate and unknown edge kinds are rejected", () => {
		expect(
			() =>
				new LanguageRegistry([
					fakeBackend("dupe", [".x"], {
						capabilities: { edgeKinds: ["contains", "contains"] },
					}),
				]),
		).toThrow(/declares edge kind "contains" twice/);

		expect(
			() =>
				new LanguageRegistry([
					fakeBackend("unknown", [".x"], {
						capabilities: {
							edgeKinds: ["contains", "teleports" as never],
						},
					}),
				]),
		).toThrow(/unknown edge kind "teleports"/);
	});

	test("an enricher without id or provenance is rejected", () => {
		expect(
			() =>
				new LanguageRegistry([
					fakeBackend("noid", [".x"], {
						enricher: { ...STUB_ENRICHER, id: "" },
						capabilities: { edgeKinds: ["contains", "calls"] },
					}),
				]),
		).toThrow(/enricher without an id/);

		expect(
			() =>
				new LanguageRegistry([
					fakeBackend("noprov", [".x"], {
						enricher: { ...STUB_ENRICHER, provenance: "" as never },
						capabilities: { edgeKinds: ["contains", "calls"] },
					}),
				]),
		).toThrow(/enricher without a provenance/);
	});

	test("a non-complement enricher is rejected at registration", () => {
		expect(
			() =>
				new LanguageRegistry([
					fakeBackend("replacer", [".x"], {
						enricher: { ...STUB_ENRICHER, mode: "replace" as never },
						capabilities: { edgeKinds: ["contains", "calls"] },
					}),
				]),
		).toThrow(/non-complement enricher/);
	});
});

describe("LanguageRegistry summary and version keys", () => {
	test("enricher status is derived from presence, not configured", () => {
		const registry = new LanguageRegistry([
			fakeBackend("passa", [".a"]),
			fakeBackend("rich", [".b"], {
				enricher: STUB_ENRICHER,
				capabilities: { edgeKinds: ["contains", "calls"] },
			}),
		]);
		expect(registry.summary().map((b) => [b.id, b.enricher])).toEqual([
			["passa", "none"],
			["rich", "complement"],
		]);
	});

	test("version keys carry the extraction contract identity so old indexes rebuild", () => {
		const registry = new LanguageRegistry([fakeBackend("passa", [".a"])]);
		expect(registry.versionKeys()["extraction:contract"]).toBe(
			EXTRACTION_CONTRACT_VERSION,
		);
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

describe("shippedBackendExtensionOwners", () => {
	test("matches the extensions the shipped backends actually claim", () => {
		// The table is static so a disabled backend can still be named; this test
		// is what keeps it from drifting away from the backend classes.
		const registry = createDefaultRegistry({ hasher: HASHER });
		const owners = shippedBackendExtensionOwners();

		const actual = new Map<string, string>();
		for (const backend of registry.list()) {
			for (const ext of backend.extensions) {
				actual.set(ext.toLowerCase(), backend.id);
			}
		}

		expect([...owners.entries()].sort()).toEqual([...actual.entries()].sort());
	});

	test("still names a backend the configuration disabled", () => {
		const registry = createDefaultRegistry({
			hasher: HASHER,
			config: { backends: { php: { enabled: false } } },
		});
		expect(registry.backendForPath("a.php")).toBeUndefined();
		// The registry forgot PHP; the shipped table has not.
		expect(shippedBackendExtensionOwners().get(".php")).toBe("php");
	});
});
