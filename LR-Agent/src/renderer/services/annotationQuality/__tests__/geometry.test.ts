import {
  computeIoU,
  computeLabelEntropy,
  findDuplicatePairs,
  percentile,
} from '../geometry';
import type { BboxQualityBox } from '../types';

describe('annotationQuality geometry', () => {
  const boxA: BboxQualityBox = {
    id: 'a',
    labelId: '1',
    labelName: 'cat',
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.2,
    area: 0.04,
  };

  const boxB: BboxQualityBox = {
    id: 'b',
    labelId: '1',
    labelName: 'cat',
    x: 0.105,
    y: 0.105,
    width: 0.2,
    height: 0.2,
    area: 0.04,
  };

  const boxC: BboxQualityBox = {
    id: 'c',
    labelId: '2',
    labelName: 'dog',
    x: 0.6,
    y: 0.6,
    width: 0.2,
    height: 0.2,
    area: 0.04,
  };

  it('computeIoU returns high overlap for similar boxes', () => {
    expect(computeIoU(boxA, boxB)).toBeGreaterThan(0.8);
  });

  it('computeIoU returns zero for disjoint boxes', () => {
    expect(computeIoU(boxA, boxC)).toBe(0);
  });

  it('findDuplicatePairs detects overlapping boxes', () => {
    const pairs = findDuplicatePairs([boxA, boxB, boxC], 0.9);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual(['a', 'b']);
  });

  it('computeLabelEntropy is normalized', () => {
    expect(computeLabelEntropy({ a: 50, b: 50 })).toBeCloseTo(1, 5);
    expect(computeLabelEntropy({ a: 100 })).toBe(0);
  });

  it('percentile returns expected value', () => {
    expect(percentile([1, 2, 3, 4, 100], 99)).toBe(100);
  });
});
