import type { Language } from "../../types";

const EXTENSION_MAP: Record<string, Language> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "jsx",
	".php": "php",
};

/**
 * Language for a path, or `undefined` when the extension is not one we know.
 * Callers must decide the fallback explicitly — silently defaulting unknown
 * files to TypeScript is what let `.php` through the TS pipeline.
 */
export function languageFromPath(filePath: string): Language | undefined {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return undefined;
	const ext = filePath.slice(dot).toLowerCase();
	return EXTENSION_MAP[ext];
}

export function extensionsForLanguage(language: Language): string[] {
	const exts: string[] = [];
	for (const [ext, lang] of Object.entries(EXTENSION_MAP)) {
		if (lang === language) exts.push(ext);
	}
	return exts;
}

/** JSX-capable languages: the only ones where a JSX literal implies a component. */
export function isJsxLanguage(language: Language | undefined): boolean {
	return language === "tsx" || language === "jsx";
}
