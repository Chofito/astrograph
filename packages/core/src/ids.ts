import type { Hasher, NodeKind } from './types';

export interface MakeNodeIdInput {
  project: string;
  filePath: string;
  kind: NodeKind;
  qualifiedName: string;
  locator?: string;
}

/**
 * Stable across reindexes; total over overloads/locals/anonymous. graph-model §2.
 *
 * The extractor is responsible for choosing `locator` only when needed:
 * signature-hash or ordinal for overloads, empty for assigned anonymous
 * functions with a binding name, and enclosing-symbol path + ordinal for truly
 * anonymous/local declarations.
 */
export function makeNodeId(input: MakeNodeIdInput, hasher: Hasher): string {
  const filePath = input.filePath.replaceAll('\\', '/');
  const qualifiedName = input.qualifiedName.replaceAll('\\', '/');
  const locator = input.locator ?? '';
  return hasher.hash([
    input.project,
    filePath,
    input.kind,
    qualifiedName,
    locator,
  ].join('\u001f'));
}
