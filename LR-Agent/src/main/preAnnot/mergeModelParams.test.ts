import { mergeModelParams } from './mergeModelParams';

describe('mergeModelParams', () => {
  it('preserves saved thresholds when optional overrides are undefined', () => {
    expect(
      mergeModelParams(
        { confThreshold: 0.3, iouThreshold: 0.5, device: 'auto' },
        { confThreshold: undefined, iouThreshold: undefined },
      ),
    ).toEqual({ confThreshold: 0.3, iouThreshold: 0.5, device: 'auto' });
  });

  it('applies explicit thresholds including zero', () => {
    expect(
      mergeModelParams(
        { confThreshold: 0.3, iouThreshold: 0.5 },
        { confThreshold: 0, iouThreshold: 0.4 },
      ),
    ).toEqual({ confThreshold: 0, iouThreshold: 0.4 });
  });
});
