import { chalkStderr } from 'chalk';

export const symbols = {
  success: '✓',
  error: '✗',
  info: 'ℹ',
  bullet: '•',
  arrow: '→',
} as const;

export function success(msg: string): string {
  return `${chalkStderr.green(symbols.success)} ${msg}`;
}

export function error(msg: string): string {
  return `${chalkStderr.red(symbols.error)} ${msg}`;
}

export function info(msg: string): string {
  return `${chalkStderr.blue(symbols.info)} ${msg}`;
}

export function arrow(msg: string): string {
  return `${chalkStderr.cyan(symbols.arrow)} ${msg}`;
}

export function dim(text: string): string {
  return chalkStderr.dim(text);
}

export function bold(text: string): string {
  return chalkStderr.bold(text);
}

export function num(n: number): string {
  return chalkStderr.cyan.bold(String(n));
}
