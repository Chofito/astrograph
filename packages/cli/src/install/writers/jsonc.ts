import { existsSync } from "node:fs";
import {
	applyEdits,
	modify,
	parse,
	type FormattingOptions,
} from "jsonc-parser";

const FMT: FormattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" };

export interface JsoncDoc {
	text: string;
}

export async function readJsonc(filePath: string): Promise<JsoncDoc> {
	if (!existsSync(filePath)) return { text: "" };
	return { text: await Bun.file(filePath).text() };
}

export function getJsoncValue(doc: JsoncDoc): Record<string, unknown> {
	if (!doc.text.trim()) return {};
	const errors: { error: number; offset: number; length: number }[] = [];
	const result = parse(doc.text, errors);
	if (errors.length > 0) {
		throw new Error(`Invalid JSONC (${errors.length} parse error(s))`);
	}
	return typeof result === "object" && result !== null
		? (result as Record<string, unknown>)
		: {};
}

export function setJsoncPath(
	doc: JsoncDoc,
	path: (string | number)[],
	value: unknown,
): JsoncDoc {
	const base = doc.text.trim() || "{}";
	const edits = modify(base, path, value, { formattingOptions: FMT });
	return { text: applyEdits(base, edits) };
}

export function serializeJsonc(doc: JsoncDoc): string {
	return doc.text.endsWith("\n") ? doc.text : doc.text + "\n";
}
