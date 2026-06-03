import type { ToolResult, TraceOutput } from '@astrograph/core';
import { formatCodeBlock, formatEdge, formatNode, withBanner } from './shared';

export function formatTrace(result: ToolResult<TraceOutput>): string {
  const data = result.data;
  const lines = [`Trace: ${data.found ? 'found' : 'not found'}`];
  if (data.hops.length > 0) {
    lines.push('', 'Hops');
    data.hops.forEach((hop, index) => {
      lines.push(`${index + 1}. ${formatNode(hop.node)}`);
      lines.push(`   via ${formatEdge(hop.via)}`);
      lines.push(formatCodeBlock(hop.body));
    });
  }
  if (data.destinationCallees !== undefined && data.destinationCallees.length > 0) {
    lines.push('', 'Destination callees');
    data.destinationCallees.forEach((node) => lines.push(`- ${formatNode(node)}`));
  }
  if (data.endpoints !== undefined && data.endpoints.length > 0) {
    lines.push('', 'Endpoints');
    data.endpoints.forEach((endpoint) => {
      lines.push(formatNode(endpoint.node));
      lines.push(formatCodeBlock(endpoint.body));
    });
  }
  return withBanner(lines.join('\n'), result.meta);
}
