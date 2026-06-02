export function parse(input: string): object;
export function parse(input: Buffer): object;
export function parse(input: string | Buffer): object {
  return {};
}

export class Formatter {
  format(value: string): string;
  format(value: number): string;
  format(value: string | number): string {
    return String(value);
  }

  format(value: boolean): string;
  format(value: Date): string;
  format(value: boolean | Date): string {
    return String(value);
  }

  single(): void {}
}
