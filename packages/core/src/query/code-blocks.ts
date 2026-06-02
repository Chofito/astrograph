import type { CodeBlock, FileSystem, Node } from '../types';

export interface CodeBlockSlicerOptions {
  fs: FileSystem;
  root: string;
}

export class CodeBlockSlicer {
  private readonly fs: FileSystem;
  private readonly root: string;

  constructor(options: CodeBlockSlicerOptions) {
    this.fs = options.fs;
    this.root = normalizePath(options.root);
  }

  async sliceNode(node: Node): Promise<CodeBlock> {
    if (node.isExternal) {
      return {
        filePath: node.filePath,
        startLine: node.range.startLine,
        endLine: node.range.endLine,
        language: node.language,
        content: '',
      };
    }

    const source = await this.fs.readText(joinPath(this.root, node.filePath));
    const lines = source.split(/\r?\n/);
    const start = Math.max(1, node.range.startLine);
    const end = Math.max(start, node.range.endLine);

    return {
      filePath: node.filePath,
      startLine: start,
      endLine: end,
      language: node.language,
      content: lines.slice(start - 1, end).join('\n'),
    };
  }
}

function joinPath(root: string, relPath: string): string {
  return `${root}/${relPath}`.replaceAll('//', '/');
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/$/, '');
}
