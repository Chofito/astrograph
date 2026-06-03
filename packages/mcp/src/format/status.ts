import type { StatusOutput, ToolResult } from '@astrograph/core';
import { withBanner } from './shared';

export function formatStatus(result: ToolResult<StatusOutput>): string {
  const data = result.data;
  const lines = [
    'Status',
    `files ${data.fileCount} · nodes ${data.nodeCount} · edges ${data.edgeCount}`,
    `backend ${data.backend} · journal ${data.journalMode} · db ${data.dbSizeBytes} bytes · updated ${data.lastUpdated}`,
    `coverage ${data.coverage.resolved}/${data.coverage.total} resolved, ${data.coverage.parsed} parsed, ${data.coverage.pending} pending`,
  ];
  if (data.pendingSync !== undefined && data.pendingSync.length > 0) {
    lines.push(`pending sync: ${data.pendingSync.join(', ')}`);
  }
  lines.push(`nodes by kind: ${formatCounts(data.nodesByKind)}`);
  lines.push(`edges by kind: ${formatCounts(data.edgesByKind)}`);
  lines.push(`files by language: ${formatCounts(data.filesByLanguage)}`);
  return withBanner(lines.join('\n'), result.meta);
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return '(none)';
  return entries.map(([key, value]) => `${key}=${value}`).join(', ');
}
