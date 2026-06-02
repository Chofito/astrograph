import type { NodeRef } from '@astrograph/core';

export function loc(node: NodeRef): string {
  return `${node.filePath}:${node.range.startLine}`;
}
