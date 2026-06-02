import type { FilesOutput, ToolResult } from '@astrograph/core';
import { footer } from './footer';

export function formatFiles(result: ToolResult<FilesOutput>, includeMetadata = true): string {
  const rows = result.data.format === 'grouped'
    ? groupedRows(result.data, includeMetadata)
    : result.data.format === 'tree'
      ? treeRows(result.data, includeMetadata)
      : flatRows(result.data, includeMetadata);
  return [...rows, footer(result.meta)].join('\n');
}

function flatRows(data: FilesOutput, includeMetadata: boolean): string[] {
  return data.entries.map((entry) => row(entry.filePath, entry, includeMetadata));
}

function groupedRows(data: FilesOutput, includeMetadata: boolean): string[] {
  const groups = new Map<string, FilesOutput['entries']>();
  for (const entry of data.entries) {
    groups.set(entry.language, [...(groups.get(entry.language) ?? []), entry]);
  }
  return [...groups.entries()].sort((a, b) => compareStrings(a[0], b[0])).flatMap(([language, entries]) => [
    language,
    ...entries.map((entry) => `  ${row(entry.filePath, entry, includeMetadata)}`),
  ]);
}

function treeRows(data: FilesOutput, includeMetadata: boolean): string[] {
  return data.entries.map((entry) => {
    const depth = Math.max(0, entry.filePath.split('/').length - 1);
    return `${'  '.repeat(depth)}${row(entry.filePath.split('/').at(-1) ?? entry.filePath, entry, includeMetadata)}`;
  });
}

function row(label: string, entry: FilesOutput['entries'][number], includeMetadata: boolean): string {
  if (!includeMetadata) return label;
  return `${label}  ${entry.language}  ${entry.nodeCount} symbols  ${entry.coverageState}`;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
