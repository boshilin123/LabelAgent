/** Bounded parallel map for generate-class annotation pipelines. */

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R | undefined>,
  isCancelled?: () => boolean,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = [];
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      if (isCancelled?.()) return;
      const index = nextIndex;
      nextIndex += 1;
      const value = await worker(items[index], index);
      if (value !== undefined) {
        results.push(value);
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}
