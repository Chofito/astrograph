import { parseArgs } from 'node:util';
import { CliError } from '../cli';

type OptionConfig = Record<string, { type: 'string' | 'boolean'; short?: string }>;

export interface ParsedArgs {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

export function parseCommandArgs(args: string[], options: OptionConfig = {}): ParsedArgs {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    return {
      values: parsed.values as Record<string, string | boolean | undefined>,
      positionals: parsed.positionals,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`${message}\nUse --help for usage.`, 1);
  }
}

export function readOptions(extra: OptionConfig = {}): OptionConfig {
  return {
    path: { type: 'string', short: 'p' },
    json: { type: 'boolean', short: 'j' },
    'fail-on-partial': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    ...extra,
  };
}

export function stringValue(values: ParsedArgs['values'], name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

export function booleanValue(values: ParsedArgs['values'], name: string): boolean {
  return values[name] === true;
}

export function numberValue(values: ParsedArgs['values'], name: string): number | undefined {
  const value = stringValue(values, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new CliError(`Expected --${name} to be a number`, 1);
  return number;
}

export function requirePositional(positionals: string[], index: number, label: string): string {
  const value = positionals[index];
  if (value === undefined || value === '') throw new CliError(`Missing ${label}`, 1);
  return value;
}

export function readFlags(values: ParsedArgs['values']): { path?: string; json?: boolean; failOnPartial?: boolean } {
  return {
    path: stringValue(values, 'path'),
    json: booleanValue(values, 'json'),
    failOnPartial: booleanValue(values, 'fail-on-partial'),
  };
}
