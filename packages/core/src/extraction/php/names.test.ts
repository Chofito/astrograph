import { describe, expect, test } from "bun:test";
import {
	isPhpBuiltinType,
	normalizePhpFqn,
	phpFqnJoin,
	resolveTypeReference,
} from "./names";

describe("PHP name resolution helpers", () => {
	test("normalizePhpFqn strips leading backslash and collapses separators", () => {
		expect(normalizePhpFqn("\\App\\Code\\Greeter")).toBe("App\\Code\\Greeter");
		expect(normalizePhpFqn("App\\\\Code")).toBe("App\\Code");
	});

	test("resolveTypeReference: absolute, alias, and current-namespace forms", () => {
		const aliases = new Map<string, string>([
			["CleanupCron", "Vendor\\Status\\Cron\\Cleanup"],
			["DataObject", "Magento\\Framework\\DataObject"],
			["Base", "Magento\\Framework\\Model\\AbstractModel"],
			["Thing", "Vendor\\Pkg\\Thing"],
		]);

		expect(
			resolveTypeReference("\\Absolute\\Iface", aliases, "App\\Code"),
		).toBe("Absolute\\Iface");
		expect(resolveTypeReference("CleanupCron", aliases, "App\\Code")).toBe(
			"Vendor\\Status\\Cron\\Cleanup",
		);
		expect(resolveTypeReference("Base", aliases, "App\\Code")).toBe(
			"Magento\\Framework\\Model\\AbstractModel",
		);
		expect(
			resolveTypeReference("BaseService", aliases, "App\\Code\\Deep"),
		).toBe("App\\Code\\Deep\\BaseService");
		expect(resolveTypeReference("Thing\\Nested", aliases, "App")).toBe(
			"Vendor\\Pkg\\Thing\\Nested",
		);
	});

	test("phpFqnJoin handles global and nested namespaces", () => {
		expect(phpFqnJoin(undefined, "GlobalClass")).toBe("GlobalClass");
		expect(phpFqnJoin("App\\Code", "Child")).toBe("App\\Code\\Child");
	});

	test("isPhpBuiltinType covers scalars and relative keywords", () => {
		expect(isPhpBuiltinType("string")).toBe(true);
		expect(isPhpBuiltinType("SELF")).toBe(true);
		expect(isPhpBuiltinType("Foo")).toBe(false);
	});
});
