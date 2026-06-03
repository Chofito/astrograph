import { existsSync } from 'node:fs';
import { parse, stringify } from 'smol-toml';

export type TomlDoc = Record<string, unknown>;

export async function readToml(filePath: string): Promise<TomlDoc> {
  if (!existsSync(filePath)) return {};
  const text = await Bun.file(filePath).text();
  if (text.trim() === '') return {};
  try {
    return parse(text) as TomlDoc;
  } catch (e) {
    throw new Error(`${filePath} contains invalid TOML: ${(e as Error).message}`);
  }
}

export function serializeToml(doc: TomlDoc): string {
  return stringify(doc as Parameters<typeof stringify>[0]);
}
