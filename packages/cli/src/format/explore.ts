import type { ExploreOutput, ToolResult } from '@astrograph/core';
import { footer } from './footer';

export function formatExplore(result: ToolResult<ExploreOutput>): string {
  const lines: string[] = [];
  for (const file of result.data.files) {
    lines.push(file.filePath);
    for (const block of file.blocks) {
      lines.push(`  ${block.startLine}-${block.endLine}`);
      lines.push(block.content.split('\n').map((line) => `    ${line}`).join('\n'));
    }
  }
  if (result.data.relationshipMap.length > 0) {
    lines.push('relationships');
    for (const edge of result.data.relationshipMap) {
      lines.push(`  ${edge.source} --${edge.kind}/${edge.resolutionState}--> ${edge.target ?? edge.targetName ?? '?'}`);
    }
  }
  lines.push(footer(result.meta));
  return lines.join('\n');
}
