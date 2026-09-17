import { computeLineDiff } from './fileDiffStats';

describe('computeLineDiff', () => {
  it('counts all lines as additions for new file', () => {
    const result = computeLineDiff('', 'line1\nline2\nline3');
    expect(result.additions).toBe(3);
    expect(result.deletions).toBe(0);
    expect(result.lines.every((l) => l.kind === 'added')).toBe(true);
  });

  it('counts modifications', () => {
    const oldText = 'alpha\nbeta\ngamma';
    const newText = 'alpha\nBETA\ngamma\ndelta';
    const result = computeLineDiff(oldText, newText);
    expect(result.additions).toBeGreaterThan(0);
    expect(result.deletions).toBeGreaterThan(0);
  });

  it('returns zero changes for identical content', () => {
    const text = 'same\ncontent';
    const result = computeLineDiff(text, text);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
  });
});
