import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { TsExtractor } from '../src/extraction/extractor';
import { normalize } from '../src/testing/normalize';
import type { Hasher } from '../src/types';

const FIXTURES_ROOT = join(import.meta.dir, '..', '__fixtures__');
const UPDATE = process.env['UPDATE_GOLDENS'] === '1';

const hasher: Hasher = {
  hash(content) {
    return String(Bun.hash(content));
  },
};

const PINNED_NOW = 1_700_000_000_000;

function extractFixture(fixturePath: string) {
  const sourcePath = join(FIXTURES_ROOT, fixturePath, 'sample.ts');
  const tsxPath = join(FIXTURES_ROOT, fixturePath, 'sample.tsx');
  const filePath = existsSync(tsxPath) ? tsxPath : sourcePath;
  const relPath = `${fixturePath}/sample${filePath.endsWith('.tsx') ? '.tsx' : '.ts'}`;
  const source = readFileSync(filePath, 'utf-8');

  const extractor = new TsExtractor({ hasher, now: () => PINNED_NOW });
  return { result: extractor.extractNodes(relPath, source), relPath };
}

function loadGolden(fixturePath: string) {
  const goldenPath = join(FIXTURES_ROOT, fixturePath, '__golden__', 'nodes.json');
  if (!existsSync(goldenPath)) return null;
  const data = JSON.parse(readFileSync(goldenPath, 'utf-8'));
  if (Array.isArray(data) && data.length === 0) return null;
  return data;
}

function saveGolden(fixturePath: string, data: unknown) {
  const goldenPath = join(FIXTURES_ROOT, fixturePath, '__golden__', 'nodes.json');
  writeFileSync(goldenPath, JSON.stringify(data, null, 2) + '\n');
}

function assertGolden(fixturePath: string) {
  const { result } = extractFixture(fixturePath);
  const normalized = normalize({ nodes: result.nodes, edges: [] });

  if (UPDATE) {
    saveGolden(fixturePath, normalized.nodes);
    return;
  }

  const golden = loadGolden(fixturePath);
  if (golden === null) {
    saveGolden(fixturePath, normalized.nodes);
    console.warn(`Golden auto-generated for ${fixturePath}. Review the output.`);
    return;
  }

  expect(normalized.nodes).toEqual(golden);
}

describe('extraction: basic', () => {
  test('produces correct nodes for basic declarations', () => {
    assertGolden('basic');
  });
});

describe('extraction: functions', () => {
  test('handles declaration, arrow, and function expression', () => {
    assertGolden('functions');
  });
});

describe('extraction: jsx', () => {
  test('identifies PascalCase components', () => {
    assertGolden('jsx');
  });
});

describe('extraction: decorators', () => {
  test('extracts decorator names', () => {
    assertGolden('decorators');
  });
});

describe('extraction: exports', () => {
  test('handles default and named exports', () => {
    assertGolden('exports');
  });
});

describe('extraction: overloads', () => {
  test('disambiguates function and method overloads', () => {
    assertGolden('overloads');
  });
});

describe('extraction: determinism', () => {
  test('extracting the same fixture twice yields identical ids and output', () => {
    const { result: first } = extractFixture('basic');
    const { result: second } = extractFixture('basic');

    expect(first.nodes.length).toBe(second.nodes.length);

    for (let i = 0; i < first.nodes.length; i++) {
      expect(first.nodes[i]!.id).toBe(second.nodes[i]!.id);
    }

    const normFirst = normalize({ nodes: first.nodes, edges: [] });
    const normSecond = normalize({ nodes: second.nodes, edges: [] });
    expect(normFirst).toEqual(normSecond);
  });

  test('no id collisions within a fixture', () => {
    const fixtures = ['basic', 'functions', 'jsx', 'decorators', 'exports', 'overloads'];
    for (const fixture of fixtures) {
      const { result } = extractFixture(fixture);
      const ids = result.nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('extraction: error handling', () => {
  test('returns error when source is not a string', () => {
    const extractor = new TsExtractor({ hasher, now: () => PINNED_NOW });
    const result = extractor.extractNodes('bad.ts', null as unknown as string);
    expect(result.nodes).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.severity).toBe('error');
    expect(result.errors[0]!.code).toBe('PARSE_ERROR');
  });
});

describe('extraction: resolveEdges stub', () => {
  test('returns empty edges and errors', () => {
    const extractor = new TsExtractor({ hasher, now: () => PINNED_NOW });
    const result = extractor.resolveEdges('any.ts');
    expect(result.edges).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
