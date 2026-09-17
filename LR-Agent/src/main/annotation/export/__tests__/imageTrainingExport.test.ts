import { filterDocsForTrainingExport } from '../imageTrainingExport';
import type { LoadedImageDoc } from '../types';

describe('filterDocsForTrainingExport', () => {
  it('skips unlabeled annotations', () => {
    const docs: LoadedImageDoc[] = [
      {
        kind: 'image',
        relativePath: 'a.jpg',
        filePath: 'a.jpg',
        source: { width: 100, height: 100 },
        annotations: [
          { kind: 'bbox', labelId: 'l1', x: 0, y: 0, width: 0.5, height: 0.5 },
          {
            kind: 'bbox',
            labelId: '',
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.2,
          },
        ],
      },
    ];
    const { docs: filtered, skippedUnlabeled } =
      filterDocsForTrainingExport(docs);
    expect(filtered[0].annotations).toHaveLength(1);
    expect(skippedUnlabeled).toBe(1);
  });
});
