import { describe, expect, it } from '@jest/globals';
import { mapWithConcurrency } from './runWithConcurrency';

describe('mapWithConcurrency', () => {
  it('keeps concurrency bound and collects defined results', async () => {
    let active = 0;
    let maxActive = 0;
    const values = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async (item) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return item % 2 === 0 ? undefined : item;
      },
    );
    expect(values.sort()).toEqual([1, 3, 5]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('stops scheduling after cancel', async () => {
    let cancelled = false;
    let started = 0;
    await mapWithConcurrency(
      [1, 2, 3, 4],
      1,
      async () => {
        started += 1;
        cancelled = true;
        return started;
      },
      () => cancelled,
    );
    expect(started).toBe(1);
  });
});
