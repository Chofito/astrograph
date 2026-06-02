import type { ToolMeta } from '../types';
import { QueryBuilder } from '../db/queries';

export interface BuildMetaOptions {
  scopeFiles?: string[];
  pendingForFiles?: string[];
  forcePartial?: boolean;
  notes?: string[];
}

export function buildMeta(queries: QueryBuilder, options: BuildMetaOptions = {}): ToolMeta {
  const coverage = queries.getCoverage(options.scopeFiles);
  const pendingFiles = options.pendingForFiles ?? queries.getPendingFiles(25, options.scopeFiles);
  const partial = options.forcePartial === true || coverage.pending > 0 || coverage.parsed > 0;
  const notes = options.notes?.filter((note) => note.trim() !== '');

  return {
    coverage,
    partial,
    pendingFiles: pendingFiles.length > 0 ? pendingFiles.slice(0, 25) : undefined,
    notes: notes !== undefined && notes.length > 0 ? notes : undefined,
  };
}
