import { describe, expect, it } from '@jest/globals';
import {
  filterPathsByScopeHint,
  resolveAnnotationScope,
  resolveAnnotationScopePaths,
  type InputPathEntry,
} from './scopePathUtil';

const samplePaths: InputPathEntry[] = [
  { relativePath: 'business_math.txt', absolutePath: '/p/business_math.txt' },
  { relativePath: 'pool_problem.txt', absolutePath: '/p/pool_problem.txt' },
  { relativePath: 'data/algebra.txt', absolutePath: '/p/data/algebra.txt' },
];

describe('filterPathsByScopeHint', () => {
  it('returns all paths when scope_hint is empty', () => {
    expect(filterPathsByScopeHint(samplePaths)).toEqual(samplePaths);
  });

  it('filters by substring match', () => {
    const filtered = filterPathsByScopeHint(samplePaths, 'pool');
    expect(filtered.map((p) => p.relativePath)).toEqual(['pool_problem.txt']);
  });

  it('filters by comma-separated tokens', () => {
    const filtered = filterPathsByScopeHint(
      samplePaths,
      'business_math.txt, algebra',
    );
    expect(filtered.map((p) => p.relativePath)).toEqual([
      'business_math.txt',
      'data/algebra.txt',
    ]);
  });

  it('matches directory prefix token', () => {
    const filtered = filterPathsByScopeHint(samplePaths, 'data/');
    expect(filtered.map((p) => p.relativePath)).toEqual(['data/algebra.txt']);
  });
});

describe('resolveAnnotationScope', () => {
  it('errors when neither paths nor all_files', () => {
    const result = resolveAnnotationScope(samplePaths, {}, 100);
    expect(result.paths).toEqual([]);
    expect(result.error).toContain('paths');
  });

  it('does not fall back to all paths when tokens miss', () => {
    const result = resolveAnnotationScope(
      samplePaths,
      { scopeHint: 'nonexistent' },
      100,
    );
    expect(result.paths).toEqual([]);
    expect(result.error).toContain('未命中');
  });

  it('uses all_files to take the catalog cap', () => {
    const result = resolveAnnotationScope(samplePaths, { allFiles: true }, 2);
    expect(result.paths).toHaveLength(2);
    expect(result.omittedCount).toBe(1);
    expect(result.omittedPaths).toEqual(['data/algebra.txt']);
    expect(result.error).toBeUndefined();
  });

  it('reports omitted paths when explicit scope exceeds maxFiles', () => {
    const many: InputPathEntry[] = Array.from({ length: 5 }, (_, i) => ({
      relativePath: `data/${i}.jpg`,
      absolutePath: `/p/data/${i}.jpg`,
    }));
    const result = resolveAnnotationScope(many, { allFiles: true }, 2);
    expect(result.paths.map((p) => p.relativePath)).toEqual([
      'data/0.jpg',
      'data/1.jpg',
    ]);
    expect(result.omittedCount).toBe(3);
    expect(result.omittedPaths).toEqual([
      'data/2.jpg',
      'data/3.jpg',
      'data/4.jpg',
    ]);
  });

  it('filters explicit paths', () => {
    const result = resolveAnnotationScope(
      samplePaths,
      { paths: ['data/'] },
      100,
    );
    expect(result.paths.map((p) => p.relativePath)).toEqual([
      'data/algebra.txt',
    ]);
  });
});

describe('resolveAnnotationScopePaths', () => {
  it('resolves exact paths via resolver when not in catalog', async () => {
    const resolved = await resolveAnnotationScopePaths(
      samplePaths,
      { paths: ['extra/new.txt'] },
      100,
      async (relativePath) =>
        relativePath === 'extra/new.txt'
          ? { relativePath, absolutePath: '/p/extra/new.txt' }
          : null,
    );
    expect(resolved.paths.map((p) => p.relativePath)).toEqual([
      'extra/new.txt',
    ]);
    expect(resolved.error).toBeUndefined();
  });

  it('errors when filtered and resolver find nothing', async () => {
    const result = await resolveAnnotationScopePaths(
      samplePaths,
      { scopeHint: 'missing-file' },
      100,
    );
    expect(result.paths).toEqual([]);
    expect(result.error).toContain('未命中');
  });
});
