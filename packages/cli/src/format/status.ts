import type { StatusOutput, ToolResult } from '@astrograph/core';
import { footer } from './footer';

export function formatStatus(result: ToolResult<StatusOutput>): string {
  const lines = [
    `files ${result.data.fileCount}`,
    `nodes ${result.data.nodeCount}`,
    `edges ${result.data.edgeCount}`,
    `coverage ${result.data.coverage.resolved}/${result.data.coverage.total} resolved (${result.data.coverage.parsed} parsed, ${result.data.coverage.pending} pending)`,
    `backend ${result.data.backend}`,
    `journal ${result.data.journalMode}`,
  ];
  if (result.data.pendingSync !== undefined && result.data.pendingSync.length > 0) {
    lines.push(`pending ${result.data.pendingSync.join(', ')}`);
  }
  lines.push(footer(result.meta));
  return lines.join('\n');
}
