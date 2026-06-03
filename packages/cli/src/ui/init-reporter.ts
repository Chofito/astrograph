import type { IndexProgress, StatusOutput } from '@astrograph/core';
import { createTerminalStyle, style, symbols } from '../format/style';

export interface InitSummary {
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  coverage: {
    resolved: number;
    total: number;
  };
}

export interface InitReporter {
  start(root: string): void;
  progress(event: IndexProgress): void;
  done(): void;
  close(): void;
}

interface TerminalStream {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): unknown;
}

export function createInitReporter(stream: TerminalStream = process.stdout): InitReporter {
  const enabled = stream.isTTY === true && process.env.CI === undefined;
  return enabled ? new FancyInitReporter(stream) : new SilentInitReporter();
}

export function summaryFromStatus(status: StatusOutput): InitSummary {
  return {
    fileCount: status.fileCount,
    nodeCount: status.nodeCount,
    edgeCount: status.edgeCount,
    coverage: {
      resolved: status.coverage.resolved,
      total: status.coverage.total,
    },
  };
}

export function formatInitReceipt(root: string, summary: InitSummary): string {
  return [
    style.success('Astrograph is ready'),
    `  ${style.path(root)}`,
    `  ${style.num(summary.fileCount)} files ${symbols.bullet} ${style.num(summary.nodeCount)} symbols ${symbols.bullet} ${style.num(summary.edgeCount)} edges`,
    `  coverage ${style.num(summary.coverage.resolved)}/${style.num(summary.coverage.total)} resolved`,
  ].join('\n');
}

class SilentInitReporter implements InitReporter {
  start(): void {}
  progress(): void {}
  done(): void {}
  close(): void {}
}

class FancyInitReporter implements InitReporter {
  private readonly stream: TerminalStream;
  private readonly ttyStyle = createTerminalStyle(true);
  private root = '';
  private current: IndexProgress = { phase: 'scan', current: 0, total: 0 };
  private renderedLines = 0;
  private lastRenderAt = 0;
  private pendingRender: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly signalHandler = (): void => {
    this.close();
    process.exit(130);
  };

  constructor(stream: TerminalStream) {
    this.stream = stream;
  }

  start(root: string): void {
    this.root = root;
    process.once('SIGINT', this.signalHandler);
    process.once('SIGTERM', this.signalHandler);
    this.stream.write('\x1b[?25l');
    this.renderNow();
  }

  progress(event: IndexProgress): void {
    this.current = event;
    this.renderThrottled();
  }

  done(): void {
    this.current = { ...this.current, phase: 'done' };
    this.renderNow();
  }

  close(): void {
    if (this.closed) return;
    if (this.pendingRender !== undefined) clearTimeout(this.pendingRender);
    this.pendingRender = undefined;
    this.clear();
    this.stream.write('\x1b[?25h');
    process.off('SIGINT', this.signalHandler);
    process.off('SIGTERM', this.signalHandler);
    this.closed = true;
  }

  private renderThrottled(): void {
    const elapsed = Date.now() - this.lastRenderAt;
    if (elapsed >= 33) {
      this.renderNow();
      return;
    }
    if (this.pendingRender !== undefined) return;
    this.pendingRender = setTimeout(() => {
      this.pendingRender = undefined;
      this.renderNow();
    }, 33 - elapsed);
  }

  private renderNow(): void {
    if (this.closed) return;
    this.lastRenderAt = Date.now();
    this.clear();
    const lines = this.lines();
    this.renderedLines = lines.length;
    this.stream.write(`${lines.join('\n')}\n`);
  }

  private clear(): void {
    if (this.renderedLines === 0) return;
    this.stream.write(`\x1b[${this.renderedLines}A`);
    for (let i = 0; i < this.renderedLines; i += 1) {
      this.stream.write('\x1b[2K');
      if (i < this.renderedLines - 1) this.stream.write('\x1b[1B');
    }
    this.stream.write(`\x1b[${this.renderedLines - 1}A`);
    this.renderedLines = 0;
  }

  private lines(): string[] {
    const phase = phaseLabel(this.current.phase);
    const total = Math.max(this.current.total, 0);
    const current = Math.min(Math.max(this.current.current, 0), total);
    const percent = progressPercent(this.current.phase, current, total);
    const width = Math.max(18, Math.min(36, (this.stream.columns ?? 80) - 38));
    const bar = progressBar(percent, width);
    const file = this.current.file === undefined
      ? this.ttyStyle.subtle('discovering project files')
      : this.ttyStyle.subtle(truncateMiddle(this.current.file, Math.max(24, (this.stream.columns ?? 80) - 18)));

    return [
      `${this.ttyStyle.accent('Astrograph')} ${this.ttyStyle.subtle(this.root)}`,
      `${phase.icon} ${this.ttyStyle.bold(phase.label)} ${bar} ${this.ttyStyle.num(percent)}%`,
      `  ${this.ttyStyle.num(current)}/${this.ttyStyle.num(total)} files ${symbols.bullet} ${file}`,
      '',
    ];
  }
}

function progressPercent(phase: IndexProgress['phase'], current: number, total: number): number {
  if (phase === 'done') return 100;
  if (phase === 'scan' || total === 0) return 0;
  const phaseProgress = current / total;
  if (phase === 'parse') return Math.round(phaseProgress * 50);
  return 50 + Math.round(phaseProgress * 50);
}

function phaseLabel(phase: IndexProgress['phase']): { icon: string; label: string } {
  switch (phase) {
    case 'scan': return { icon: symbols.bullet, label: 'Scanning' };
    case 'parse': return { icon: '◐', label: 'Parsing' };
    case 'resolve': return { icon: '◒', label: 'Resolving' };
    case 'done': return { icon: symbols.success, label: 'Complete' };
  }
}

function progressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = Math.max(0, width - filled);
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const left = Math.max(8, Math.floor((maxLength - 1) * 0.55));
  const right = Math.max(8, maxLength - left - 1);
  return `${text.slice(0, left)}…${text.slice(text.length - right)}`;
}
