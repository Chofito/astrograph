import type { ContextOutput, ToolResult } from '@astrograph/core';
import { footer } from './footer';
import { loc } from './shared';

export function formatContext(result: ToolResult<ContextOutput>): string {
  const lines = ['# Context', '', '## Entry points'];
  for (const node of result.data.entryPoints) {
    lines.push(`- ${node.kind} ${node.name}  ${loc(node)}`);
  }
  lines.push('', '## Included symbols');
  for (const node of result.data.subgraph.nodes) {
    lines.push(`- ${node.kind} ${node.name}  ${result.data.inclusionReasons[node.id] ?? 'included'}  ${loc(node)}`);
  }
  if (result.data.codeBlocks.length > 0) {
    lines.push('', '## Code');
    for (const block of result.data.codeBlocks) {
      lines.push('', `### ${block.filePath}:${block.startLine}-${block.endLine}`);
      lines.push('```' + block.language);
      lines.push(block.content);
      lines.push('```');
    }
  }
  lines.push('', footer(result.meta));
  return lines.join('\n');
}
