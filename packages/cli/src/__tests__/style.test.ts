import { describe, expect, test } from 'bun:test';
import { createTerminalStyle, style, symbols } from '../format/style';

describe('style helpers', () => {
  test('success emits checkmark and message', () => {
    const result = style.success('Indexed /project');
    expect(result).toContain(symbols.success);
    expect(result).toContain('Indexed /project');
  });

  test('error emits cross and message', () => {
    const result = style.error('Failed to index');
    expect(result).toContain(symbols.error);
    expect(result).toContain('Failed to index');
  });

  test('warn emits warning symbol and message', () => {
    const result = style.warn('Aborted');
    expect(result).toContain(symbols.warn);
    expect(result).toContain('Aborted');
  });

  test('info emits info symbol and message', () => {
    const result = style.info('No index at /project');
    expect(result).toContain(symbols.info);
    expect(result).toContain('No index at /project');
  });

  test('dim wraps text', () => {
    const result = style.dim('Project:');
    expect(result).toContain('Project:');
  });

  test('bold wraps text', () => {
    const result = style.bold('Astrograph Status');
    expect(result).toContain('Astrograph Status');
  });

  test('num emits number', () => {
    const result = style.num(123);
    expect(result).toContain('123');
  });

  test('path emits path', () => {
    const result = style.path('/project/root');
    expect(result).toContain('/project/root');
  });

  test('added emits +number', () => {
    const result = style.added(5);
    expect(result).toContain('+5');
  });

  test('modified emits ~number', () => {
    const result = style.modified(3);
    expect(result).toContain('~3');
  });

  test('removed emits -number', () => {
    const result = style.removed(2);
    expect(result).toContain('-2');
  });

  test('header emits text', () => {
    const result = style.header('Astrograph Status');
    expect(result).toContain('Astrograph Status');
  });

  test('symbols are plain unicode', () => {
    expect(symbols.success).toBe('✓');
    expect(symbols.error).toBe('✗');
    expect(symbols.warn).toBe('⚠');
    expect(symbols.info).toBe('ℹ');
    expect(symbols.bullet).toBe('•');
    expect(symbols.arrow).toBe('→');
  });
});

describe('non-TTY output', () => {
  const plainStyle = createTerminalStyle(false, {});

  test('chalk auto-disables when not a TTY', () => {
    const result = plainStyle.success('test message');
    const hasAnsiCodes = /\x1b\[[0-9;]*m/.test(result);
    expect(hasAnsiCodes).toBe(false);
  });

  test('num helper has no ANSI codes in non-TTY', () => {
    const result = plainStyle.num(42);
    const hasAnsiCodes = /\x1b\[[0-9;]*m/.test(result);
    expect(hasAnsiCodes).toBe(false);
    expect(result).toContain('42');
  });

  test('added helper has no ANSI codes in non-TTY', () => {
    const result = plainStyle.added(10);
    const hasAnsiCodes = /\x1b\[[0-9;]*m/.test(result);
    expect(hasAnsiCodes).toBe(false);
    expect(result).toContain('+10');
  });

  test('modified helper has no ANSI codes in non-TTY', () => {
    const result = plainStyle.modified(5);
    const hasAnsiCodes = /\x1b\[[0-9;]*m/.test(result);
    expect(hasAnsiCodes).toBe(false);
    expect(result).toContain('~5');
  });

  test('removed helper has no ANSI codes in non-TTY', () => {
    const result = plainStyle.removed(3);
    const hasAnsiCodes = /\x1b\[[0-9;]*m/.test(result);
    expect(hasAnsiCodes).toBe(false);
    expect(result).toContain('-3');
  });
});
