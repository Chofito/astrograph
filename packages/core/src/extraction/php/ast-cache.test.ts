import { describe, expect, test } from "bun:test";
import { PhpAstCache } from "./ast-cache";

describe("PhpAstCache", () => {
	test("parse then release leaves zero live trees", () => {
		const cache = new PhpAstCache();
		cache.setRootPath("/tmp");
		const first = cache.parse("a.php", "<?php class A {}");
		expect(first).toBeDefined();
		expect(cache.size).toBe(1);
		cache.release("a.php");
		expect(cache.size).toBe(0);

		const second = cache.parse("b.php", "<?php class B {}");
		expect(second).toBeDefined();
		expect(cache.size).toBe(1);
		cache.parse("c.php", "<?php class C {}");
		expect(cache.size).toBe(1);
		cache.clear();
		expect(cache.size).toBe(0);
		cache.dispose();
	});
});
