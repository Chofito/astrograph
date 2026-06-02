import type { Hasher } from '../../types';

export class BunHasher implements Hasher {
  hash(content: string | Uint8Array): string {
    return String(Bun.hash(content));
  }
}
