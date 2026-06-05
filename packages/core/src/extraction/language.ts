import type { Language } from "../types";

const EXTENSION_MAP: Record<string, Language> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "jsx",
};

export function languageFromPath(filePath: string): Language {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return "typescript";
	const ext = filePath.slice(dot).toLowerCase();
	return EXTENSION_MAP[ext] ?? "typescript";
}
