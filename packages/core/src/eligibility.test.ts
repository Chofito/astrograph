import { describe, expect, test } from "bun:test";
import { normalizeAstrographConfig } from "./config";
import {
	buildMembership,
	classifyPath,
	eligibilityEvidence,
	materialize,
} from "./eligibility";
import { LanguageRegistry } from "./extraction/registry";
import type { LanguageBackend, PassAResult } from "./types";

const NOOP: PassAResult = { nodes: [], edges: [], errors: [] };

function backend(id: string, extensions: string[]): LanguageBackend {
	return {
		id,
		languages: [id],
		extensions,
		parser: { extractNodes: () => NOOP },
		capabilities: { edgeKinds: ["contains"] },
		versionKeys: () => ({ v: "1" }),
	};
}

const TS = backend("typescript", [".ts", ".tsx"]);
const PHP = backend("php", [".php"]);

function options(overrides: { maxFileSizeBytes?: number } = {}) {
	return {
		registry: new LanguageRegistry([TS, PHP]),
		config: normalizeAstrographConfig(
			overrides.maxFileSizeBytes === undefined
				? {}
				: { maxFileSizeBytes: overrides.maxFileSizeBytes },
			{ knownBackendIds: ["typescript", "php"] },
		),
		shippedExtensionOwners: new Map([
			[".ts", "typescript"],
			[".tsx", "typescript"],
			[".php", "php"],
		]),
	};
}

describe("classifyPath", () => {
	test("an owned file within the size limit is eligible and attributed", () => {
		const entry = classifyPath("src/a.ts", { ...options(), size: 100 });
		expect(entry).toMatchObject({
			path: "src/a.ts",
			backendId: "typescript",
			eligible: true,
			size: 100,
		});
		expect(entry.reason).toBeUndefined();
	});

	test("an unclaimed extension is no_backend", () => {
		const entry = classifyPath("README.md", { ...options(), size: 10 });
		expect(entry).toMatchObject({ eligible: false, reason: "no_backend" });
		expect(entry.backendId).toBeUndefined();
	});

	test("a shipped-but-disabled backend reports backend_disabled, not no_backend", () => {
		// The registry omits a disabled backend entirely, so without the shipped
		// owner table ".php" would look like an unsupported extension. "PHP is off"
		// is actionable; "nothing reads .php" is not.
		const withoutPhp = {
			...options(),
			registry: new LanguageRegistry([TS]),
		};
		const entry = classifyPath("src/a.php", { ...withoutPhp, size: 10 });
		expect(entry).toMatchObject({
			eligible: false,
			reason: "backend_disabled",
			backendId: "php",
		});
	});

	test("a file over the limit is not eligible but keeps its attribution", () => {
		const entry = classifyPath("src/a.ts", {
			...options({ maxFileSizeBytes: 50 }),
			size: 51,
		});
		expect(entry).toMatchObject({
			eligible: false,
			reason: "too_large",
			backendId: "typescript",
			size: 51,
		});
	});

	test("exactly at the limit is still eligible", () => {
		const entry = classifyPath("src/a.ts", {
			...options({ maxFileSizeBytes: 50 }),
			size: 50,
		});
		expect(entry.eligible).toBe(true);
	});

	test("an unstattable path is missing, never silently eligible", () => {
		const entry = classifyPath("src/a.ts", { ...options(), size: undefined });
		expect(entry).toMatchObject({ eligible: false, reason: "missing" });
	});

	test("a path the scanner did not yield is out_of_scope", () => {
		const entry = classifyPath("src/a.ts", {
			...options(),
			size: 10,
			inScanScope: false,
		});
		expect(entry).toMatchObject({ eligible: false, reason: "out_of_scope" });
	});
});

describe("buildMembership", () => {
	const sizes: Record<string, number> = {
		"src/a.ts": 10,
		"src/b.php": 20,
		"src/huge.ts": 10_000,
		"README.md": 5,
	};
	const sizeOf = async (path: string) => sizes[path];

	test("is deterministic and ordered by path, not by registration order", async () => {
		const forward = await buildMembership({
			...options(),
			scanned: ["src/b.php", "README.md", "src/a.ts"],
			sizeOf,
		});
		const reversed = await buildMembership({
			...options(),
			registry: new LanguageRegistry([PHP, TS]),
			scanned: ["src/a.ts", "src/b.php", "README.md"],
			sizeOf,
		});

		expect(forward.all.map((e) => e.path)).toEqual([
			"README.md",
			"src/a.ts",
			"src/b.php",
		]);
		expect(forward.all).toEqual(reversed.all);
		expect([...forward.byBackend.keys()]).toEqual(["php", "typescript"]);
	});

	test("byBackend contains only eligible files", async () => {
		const membership = await buildMembership({
			...options({ maxFileSizeBytes: 100 }),
			scanned: ["src/a.ts", "src/huge.ts", "src/b.php"],
			sizeOf,
		});

		// The oversized file must never reach a backend's loadProject set.
		expect(membership.byBackend.get("typescript")).toEqual(["src/a.ts"]);
		expect(membership.byBackend.get("php")).toEqual(["src/b.php"]);
		expect(membership.isEligible("src/huge.ts")).toBe(false);
	});

	test("a known path the scanner no longer yields becomes out_of_scope", async () => {
		const membership = await buildMembership({
			...options(),
			scanned: ["src/a.ts"],
			known: ["src/a.ts", "src/gone.ts"],
			sizeOf,
		});

		expect(membership.get("src/gone.ts")).toEqual({
			path: "src/gone.ts",
			eligible: false,
			reason: "out_of_scope",
		});
		// Out of scope is not evidence: the project simply does not contain it.
		expect(membership.recordable.map((e) => e.path)).toEqual([]);
	});

	test("recordable carries the unusable files, never the out-of-scope ones", async () => {
		const membership = await buildMembership({
			...options({ maxFileSizeBytes: 100 }),
			scanned: ["src/huge.ts", "README.md"],
			known: ["src/left-the-project.ts"],
			sizeOf,
		});

		expect(membership.recordable.map((e) => [e.path, e.reason])).toEqual([
			["README.md", "no_backend"],
			["src/huge.ts", "too_large"],
		]);
	});

	test("disabling a backend removes its files from active membership", async () => {
		const enabled = await buildMembership({
			...options(),
			scanned: ["src/a.ts", "src/b.php"],
			sizeOf,
		});
		expect(enabled.eligible.map((e) => e.path)).toEqual([
			"src/a.ts",
			"src/b.php",
		]);

		const disabled = await buildMembership({
			...options(),
			registry: new LanguageRegistry([TS]),
			scanned: ["src/a.ts", "src/b.php"],
			sizeOf,
		});
		expect(disabled.eligible.map((e) => e.path)).toEqual(["src/a.ts"]);
		expect(disabled.byBackend.has("php")).toBe(false);
		expect(disabled.get("src/b.php")?.reason).toBe("backend_disabled");
	});

	test("raising the size limit brings a file back into membership", async () => {
		const tight = await buildMembership({
			...options({ maxFileSizeBytes: 100 }),
			scanned: ["src/huge.ts"],
			sizeOf,
		});
		expect(tight.eligible).toEqual([]);

		const loose = await buildMembership({
			...options({ maxFileSizeBytes: 1_000_000 }),
			scanned: ["src/huge.ts"],
			sizeOf,
		});
		expect(loose.eligible.map((e) => e.path)).toEqual(["src/huge.ts"]);
	});
});

describe("eligibilityEvidence", () => {
	test("maps each recordable reason to a registered diagnostic code", () => {
		expect(
			eligibilityEvidence({
				path: "a.ts",
				eligible: false,
				reason: "too_large",
				size: 9,
			})?.code,
		).toBe("FILE_TOO_LARGE");
		expect(
			eligibilityEvidence({ path: "a.md", eligible: false, reason: "no_backend" })
				?.code,
		).toBe("NO_BACKEND");
		expect(
			eligibilityEvidence({
				path: "a.php",
				eligible: false,
				reason: "backend_disabled",
				backendId: "php",
			})?.code,
		).toBe("NO_BACKEND");
	});

	test("an eligible or out-of-scope entry produces no evidence", () => {
		expect(eligibilityEvidence({ path: "a.ts", eligible: true })).toBeNull();
		expect(
			eligibilityEvidence({
				path: "a.ts",
				eligible: false,
				reason: "out_of_scope",
			}),
		).toBeNull();
	});
});

describe("materialize", () => {
	test("empty input yields an empty, safe membership", () => {
		const membership = materialize([]);
		expect(membership.all).toEqual([]);
		expect(membership.eligible).toEqual([]);
		expect(membership.byBackend.size).toBe(0);
		expect(membership.isEligible("anything.ts")).toBe(false);
		expect(membership.get("anything.ts")).toBeUndefined();
	});
});
