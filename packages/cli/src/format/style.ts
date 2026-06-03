import chalk, { chalkStderr, type ChalkInstance } from 'chalk';

export const symbols = {
  success: '✓',
  error: '✗',
  warn: '⚠',
  info: 'ℹ',
  bullet: '•',
  arrow: '→',
} as const;

export interface StyleHelpers {
  success: (msg: string) => string;
  error: (msg: string) => string;
  warn: (msg: string) => string;
  info: (msg: string) => string;
  step: (msg: string) => string;
  dim: (text: string) => string;
  bold: (text: string) => string;
  count: (n: number, label: string) => string;
  num: (n: number) => string;
  path: (p: string) => string;
  added: (n: number) => string;
  modified: (n: number) => string;
  removed: (n: number) => string;
  header: (text: string) => string;
}

function createStyle(c: ChalkInstance): StyleHelpers {
  return {
    success: (msg) => `${c.green(symbols.success)} ${msg}`,
    error: (msg) => `${c.red(symbols.error)} ${msg}`,
    warn: (msg) => `${c.yellow(symbols.warn)} ${msg}`,
    info: (msg) => `${c.blue(symbols.info)} ${msg}`,
    step: (msg) => `${c.cyan(symbols.bullet)} ${msg}`,
    dim: (text) => c.dim(text),
    bold: (text) => c.bold(text),
    count: (n, label) => `${c.cyan(String(n))} ${label}`,
    num: (n) => c.cyan.bold(String(n)),
    path: (p) => c.dim(p),
    added: (n) => c.green(`+${n}`),
    modified: (n) => c.yellow(`~${n}`),
    removed: (n) => c.red(`-${n}`),
    header: (text) => c.bold(text),
  };
}

export const style = createStyle(chalk);
export const styleStderr = createStyle(chalkStderr);
