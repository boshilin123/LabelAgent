import { describe, expect, it } from '@jest/globals';
import { validateSpanRows } from './spanValidation';

const labels = [
  { id: 'l1', name: 'PER', color: '#f00' },
  { id: 'l2', name: 'ORG', color: '#0f0' },
];

describe('validateSpanRows', () => {
  it('locates span text in source when offsets omitted', () => {
    const source = '张三在北京工作';
    const { spans, skipped } = validateSpanRows(
      source,
      [{ text: '张三', labelName: 'PER' }],
      labels,
    );
    expect(skipped).toBe(0);
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBe(0);
    expect(spans[0].end).toBe(2);
    expect(spans[0].labelId).toBe('l1');
  });

  it('skips unknown labels', () => {
    const { spans, skipped } = validateSpanRows(
      'hello world',
      [{ text: 'hello', labelName: 'UNKNOWN' }],
      labels,
    );
    expect(spans).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('merges overlapping spans with same label', () => {
    const source = 'abcdef';
    const { spans } = validateSpanRows(
      source,
      [
        { text: 'ab', start: 0, end: 2, labelName: 'PER' },
        { text: 'bc', start: 1, end: 3, labelName: 'PER' },
      ],
      labels,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBe(0);
    expect(spans[0].end).toBe(3);
  });
});
