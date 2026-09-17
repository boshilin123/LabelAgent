import { loadAllAnnotationDocs } from '../../annotationDataStore';
import { loadExportDocs } from '../loadExportDocs';

jest.mock('../../annotationDataStore', () => ({
  loadAllAnnotationDocs: jest.fn(),
}));

const mockedLoad = loadAllAnnotationDocs as jest.MockedFunction<
  typeof loadAllAnnotationDocs
>;

describe('loadExportDocs', () => {
  beforeEach(() => {
    mockedLoad.mockReset();
  });

  it('loads image docs and reports missing dimensions', async () => {
    mockedLoad.mockResolvedValue([
      {
        relativePath: 'ok.jpg',
        doc: {
          modality: 'image',
          annotationType: 'bbox',
          source: { width: 640, height: 480 },
          annotations: [{ kind: 'bbox', labelId: 'l1' }],
        },
      },
      {
        relativePath: 'bad.jpg',
        doc: {
          modality: 'image',
          annotationType: 'bbox',
          annotations: [],
        },
      },
    ]);

    const result = await loadExportDocs('/proj', 'image', 'bbox', false);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].kind).toBe('image');
    expect(result.skippedFiles.some((s) => s.includes('bad.jpg'))).toBe(true);
  });

  it('loads text docs without image dimensions', async () => {
    mockedLoad.mockResolvedValue([
      {
        relativePath: 'doc.txt',
        doc: {
          modality: 'text',
          annotationType: 'instruction',
          annotations: [
            {
              kind: 'instruction',
              instruction: 'A',
              output: 'B',
            },
          ],
        },
      },
    ]);

    const result = await loadExportDocs('/proj', 'text', 'instruction', false);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].kind).toBe('text');
  });

  it('warns on annotationType mismatch', async () => {
    mockedLoad.mockResolvedValue([
      {
        relativePath: 'x.txt',
        doc: {
          modality: 'text',
          annotationType: 'conversation',
          annotations: [{ kind: 'conversation', turns: [] }],
        },
      },
    ]);

    const result = await loadExportDocs('/proj', 'text', 'instruction', false);
    expect(result.docs).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('不一致'))).toBe(true);
  });
});
