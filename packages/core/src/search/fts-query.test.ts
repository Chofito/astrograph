import { describe, expect, test } from "bun:test";
import { toFtsMatchQuery } from "./fts-query";

describe("toFtsMatchQuery", () => {
	test("turns a sentence into OR-ed quoted prefix content tokens", () => {
		expect(toFtsMatchQuery("how does useAddToCart work")).toBe(
			'"add"* OR "cart"* OR "use"* OR "useaddtocart"*',
		);
	});

	test("keeps compound identifiers while adding deterministic sub-tokens", () => {
		expect(toFtsMatchQuery("useAddToCart")).toBe(
			'"add"* OR "cart"* OR "use"* OR "useaddtocart"*',
		);
	});

	test("drops stopwords and FTS boolean operators", () => {
		expect(toFtsMatchQuery("find auth AND session OR token NEAR cache")).toBe(
			'"auth"* OR "cache"* OR "session"* OR "token"*',
		);
	});

	test("strips punctuation, quotes, parens, qualifiers, and member separators", () => {
		expect(toFtsMatchQuery('CartService::useAddToCart("sku.id")')).toBe(
			'"add"* OR "cart"* OR "cartservice"* OR "id"* OR "sku"* OR "skuid"* OR "use"* OR "useaddtocart"*',
		);
	});

	test("keeps snake and dotted compounds while adding parts", () => {
		expect(toFtsMatchQuery("user_service cart.total")).toBe(
			'"cart"* OR "carttotal"* OR "total"* OR "user"* OR "user_service"*',
		);
	});

	test("keeps a single token query as a quoted prefix token", () => {
		expect(toFtsMatchQuery("helper")).toBe('"helper"*');
	});

	test("returns empty for whitespace-only input", () => {
		expect(toFtsMatchQuery("   \n\t  ")).toBe("");
	});

	test("falls back to raw alphanumeric tokens when stopwords remove everything", () => {
		expect(toFtsMatchQuery("how does it work")).toBe(
			'"does"* OR "how"* OR "it"* OR "work"*',
		);
	});
});
