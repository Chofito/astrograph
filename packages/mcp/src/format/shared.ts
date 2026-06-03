import type { CodeBlock, EdgeRef, NodeRef, ToolMeta } from '@astrograph/core';

export function banner(meta: ToolMeta): string {
  const parts = [
    `coverage ${meta.coverage.resolved}/${meta.coverage.total} resolved`,
    `partial: ${meta.partial ? 'yes' : 'no'}`,
  ];
  if (meta.pendingFiles !== undefined && meta.pendingFiles.length > 0) {
    parts.push(`pending: ${meta.pendingFiles.join(', ')}`);
  }
  if (meta.notes !== undefined && meta.notes.length > 0) {
    parts.push(meta.notes.join(' · '));
  }
  return parts.join(' · ');
}

export function withBanner(body: string, meta: ToolMeta): string {
  const trimmed = body.trimEnd();
  return `${trimmed}\n\n${banner(meta)}`;
}

export function formatRange(node: NodeRef): string {
  return `${node.filePath}:${node.range.startLine}-${node.range.endLine}`;
}

export function formatNode(node: NodeRef): string {
  const signature = node.signature === undefined ? '' : ` ${node.signature}`;
  return `${node.name} [${node.kind}] ${formatRange(node)}${signature}`;
}

export function formatEdge(edge: EdgeRef): string {
  const target = edge.targetName ?? edge.target ?? 'unresolved';
  const at = edge.line === undefined ? '' : ` @ ${edge.line}${edge.col === undefined ? '' : `:${edge.col}`}`;
  return `${edge.kind} ${edge.source} -> ${target} (${edge.resolutionState}, ${edge.confidence})${at}`;
}

export function formatCodeBlock(block: CodeBlock): string {
  const content = block.content.endsWith('\n') ? block.content : `${block.content}\n`;
  return `${block.filePath}:${block.startLine}-${block.endLine}\n\`\`\`${block.language}\n${content}\`\`\``;
}

export function empty(label: string): string {
  return `${label}\n(no results)`;
}
