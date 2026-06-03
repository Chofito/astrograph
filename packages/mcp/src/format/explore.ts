import type { ExploreOutput, ToolResult } from '@astrograph/core';
import { empty, formatCodeBlock, formatEdge, withBanner } from './shared';

export function formatExplore(result: ToolResult<ExploreOutput>): string {
  if (result.data.files.length === 0) return withBanner(empty('Explore'), result.meta);
  const lines = ['Explore'];
  result.data.files.forEach((file) => {
    lines.push('', file.filePath);
    file.blocks.forEach((block) => lines.push(formatCodeBlock(block)));
  });
  if (result.data.relationshipMap.length > 0) {
    lines.push('', 'Relationships');
    result.data.relationshipMap.forEach((edge) => lines.push(`- ${formatEdge(edge)}`));
  }
  return withBanner(lines.join('\n'), result.meta);
}
