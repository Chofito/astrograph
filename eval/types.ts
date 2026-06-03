import type { NodeKind } from '@astrograph/core';

export interface EvalCase {
  id: string;
  query: string;
  api: 'search' | 'context';
  expectedSymbols: string[];
  kind?: NodeKind;
}

export interface EvalResult {
  caseId: string;
  pass: boolean;
  recall: number;
  mrr: number;
  found: string[];
  missed: string[];
  latencyMs: number;
}
