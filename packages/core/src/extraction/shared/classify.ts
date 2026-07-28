import type { Language } from "../../types";
import { languageFromPath } from "./language";

// --- JS/TS (unchanged semantics) -------------------------------------------
const JS_GENERATED_EXT_RE = /\.(generated|gen)\.[jt]sx?$/;
const JS_GENERATED_PB_RE = /\.pb\.[jt]s$/;
const JS_TEST_EXT_RE = /\.(test|spec)\.[jt]sx?$/;

// --- PHP --------------------------------------------------------------------
const PHP_GENERATED_EXT_RE = /\.(generated|gen)\.php$/i;
// PSR-ish and PHPUnit conventions: FooTest.php, foo_test.php, FooTest.inc.
const PHP_TEST_EXT_RE = /(Test|_test)\.php$/;
const PHP_TEST_DIR_RE = /(^|\/)(tests?|Tests)\//;

// --- language-agnostic ------------------------------------------------------
const GENERATED_DIR_RE = /(^|\/)__generated__\//;
const COMMON_TEST_DIR_RE = /(^|\/)(__tests__|e2e)\//;

/** `// @generated` — the JS/TS convention. */
const JS_GENERATED_HEADER_RE = /^\s*\/\/\s*(@generated|Code generated)/;
/** PHP allows `//`, `#` and `/* *​/` comments, optionally after `<?php`. */
const PHP_GENERATED_HEADER_RE =
	/^\s*(?:<\?php\s*)?(?:\/\/|#|\/\*+)\s*(@generated|Code generated)/;

function resolveLanguage(
	filePath: string,
	language?: Language,
): Language | undefined {
	return language ?? languageFromPath(filePath);
}

export function isGenerated(
	filePath: string,
	source?: string,
	language?: Language,
): boolean {
	const lang = resolveLanguage(filePath, language);
	if (GENERATED_DIR_RE.test(filePath)) return true;

	if (lang === "php") {
		if (PHP_GENERATED_EXT_RE.test(filePath)) return true;
		if (source !== undefined && PHP_GENERATED_HEADER_RE.test(source))
			return true;
		return false;
	}

	if (JS_GENERATED_EXT_RE.test(filePath)) return true;
	if (JS_GENERATED_PB_RE.test(filePath)) return true;
	if (source !== undefined && JS_GENERATED_HEADER_RE.test(source)) return true;
	return false;
}

export function isTest(filePath: string, language?: Language): boolean {
	const lang = resolveLanguage(filePath, language);
	if (COMMON_TEST_DIR_RE.test(filePath)) return true;

	if (lang === "php") {
		if (PHP_TEST_EXT_RE.test(filePath)) return true;
		if (PHP_TEST_DIR_RE.test(filePath)) return true;
		return false;
	}

	if (JS_TEST_EXT_RE.test(filePath)) return true;
	return false;
}
