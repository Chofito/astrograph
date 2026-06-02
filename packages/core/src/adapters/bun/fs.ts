import type { FileSystem } from '../../types';

export class BunFileSystem implements FileSystem {
  async readText(path: string): Promise<string> {
    return Bun.file(path).text();
  }

  async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
  }

  async stat(path: string): Promise<{ size: number; modifiedAt: number }> {
    const file = Bun.file(path);
    return {
      size: file.size,
      modifiedAt: file.lastModified,
    };
  }
}
