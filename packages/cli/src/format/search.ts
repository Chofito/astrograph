import type { SearchOutput, ToolResult } from '@astrograph/core';
import { footer } from './footer';
import { loc } from './shared';

export function formatSearch(result: ToolResult<SearchOutput>): string {
  const rows = result.data.map((item) => `${item.node.kind} ${item.node.name}  ${loc(item.node)}`);
  return [...rows, footer(result.meta)].join('\n');
}
