import type { ToolMeta } from '@astrograph/core';

export function footer(meta: ToolMeta): string {
  const parts = [
    `coverage ${meta.coverage.resolved}/${meta.coverage.total} resolved`,
    `partial: ${meta.partial ? 'yes' : 'no'}`,
  ];
  if (meta.pendingFiles !== undefined && meta.pendingFiles.length > 0) {
    parts.push(`pending: ${meta.pendingFiles.join(', ')}`);
  }
  if (meta.notes !== undefined && meta.notes.length > 0) {
    parts.push(`notes: ${meta.notes.join('; ')}`);
  }
  return parts.join(' · ');
}
