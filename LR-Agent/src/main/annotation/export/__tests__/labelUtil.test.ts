import { LabelResolver } from '../labelUtil';

describe('LabelResolver', () => {
  const labels = [
    { id: 'l1', name: 'cat' },
    { id: 'l2', name: 'dog' },
  ];

  it('returns index for known label', () => {
    const resolver = new LabelResolver(labels);
    expect(resolver.index('l2')).toBe(1);
    expect(resolver.unknownCount).toBe(0);
  });

  it('returns null and increments unknownCount for unknown label', () => {
    const resolver = new LabelResolver(labels);
    expect(resolver.index('missing')).toBeNull();
    expect(resolver.index('missing')).toBeNull();
    expect(resolver.unknownCount).toBe(2);
  });

  it('resolves label name', () => {
    const resolver = new LabelResolver(labels);
    expect(resolver.name('l1')).toBe('cat');
    expect(resolver.name('x')).toBe('unknown');
  });
});
