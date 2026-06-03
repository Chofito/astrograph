import type { StatusOutput, ToolResult } from '@astrograph/core';
import { footer } from './footer';
import { style, symbols } from './style';

export function formatStatus(result: ToolResult<StatusOutput>): string {
  const lines = [
    style.header('Astrograph Status'),
    `${symbols.bullet} files      ${style.num(result.data.fileCount)}`,
    `${symbols.bullet} nodes      ${style.num(result.data.nodeCount)}`,
    `${symbols.bullet} edges      ${style.num(result.data.edgeCount)}`,
    `${symbols.bullet} coverage   ${style.num(result.data.coverage.resolved)}/${style.num(result.data.coverage.total)} resolved (${result.data.coverage.parsed} parsed, ${result.data.coverage.pending} pending)`,
    `${symbols.bullet} backend    ${style.dim(result.data.backend)}`,
    `${symbols.bullet} journal    ${style.dim(result.data.journalMode)}`,
  ];
  if (result.data.pendingSync !== undefined && result.data.pendingSync.length > 0) {
    lines.push(`${symbols.bullet} pending    ${result.data.pendingSync.join(', ')}`);
  }
  lines.push(footer(result.meta));
  return lines.join('\n');
}
