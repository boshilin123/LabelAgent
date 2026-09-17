import { describe, expect, it } from '@jest/globals';
import { getViewerType, resolveViewerType } from './fileViewerType';

describe('getViewerType', () => {
  it('returns markdown for .md files', () => {
    expect(getViewerType('/ws/readme.md')).toBe('markdown');
  });

  it('returns text for plain text files', () => {
    expect(getViewerType('/ws/note.txt')).toBe('text');
    expect(getViewerType('/ws/data/train.jsonl')).toBe('text');
  });
});

describe('resolveViewerType', () => {
  it('prefers text over markdown in annotation mode', () => {
    expect(
      resolveViewerType('/ws/readme.md', { preferTextForMarkdown: true }),
    ).toBe('text');
  });

  it('keeps markdown preview when not in annotation mode', () => {
    expect(resolveViewerType('/ws/readme.md')).toBe('markdown');
    expect(
      resolveViewerType('/ws/readme.md', { preferTextForMarkdown: false }),
    ).toBe('markdown');
  });

  it('respects forceViewerType override', () => {
    expect(
      resolveViewerType('/ws/readme.md', {
        forceViewerType: 'binary',
        preferTextForMarkdown: true,
      }),
    ).toBe('binary');
  });

  it('does not change non-markdown types', () => {
    expect(
      resolveViewerType('/ws/note.txt', { preferTextForMarkdown: true }),
    ).toBe('text');
  });
});
