import { existsSync } from 'node:fs';

export type JsonDoc = Record<string, unknown>;

export async function readJson(filePath: string): Promise<JsonDoc> {
  if (!existsSync(filePath)) return {};
  const text = await Bun.file(filePath).text();
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${filePath} contains invalid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a JSON object`);
  }
  return parsed as JsonDoc;
}

export function serializeJson(doc: JsonDoc): string {
  return JSON.stringify(doc, null, 2) + '\n';
}
