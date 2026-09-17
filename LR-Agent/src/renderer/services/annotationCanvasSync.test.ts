import { decideCanvasAfterExternalApply } from './annotationCanvasSync';
import type { FileAnnotationDocument } from '../types/annotationDocument';

const parsed: FileAnnotationDocument = {
  schemaVersion: 1,
  projectId: 'p1',
  filePath: 'data/1.jpg',
  modality: 'image',
  annotationType: 'bbox',
  annotations: [
    {
      id: 'a1',
      kind: 'bbox',
      labelId: 'l1',
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
      createdAt: '',
      updatedAt: '',
    },
  ],
  updatedAt: '',
};

describe('decideCanvasAfterExternalApply', () => {
  it('skips when dirty and not forced', () => {
    expect(
      decideCanvasAfterExternalApply({ parsed, dirty: true, force: false }),
    ).toEqual({ action: 'skip' });
  });

  it('clears when document is missing', () => {
    expect(
      decideCanvasAfterExternalApply({
        parsed: null,
        dirty: false,
        force: false,
      }),
    ).toEqual({ action: 'clear' });
  });

  it('clears missing document even when dirty if forced', () => {
    expect(
      decideCanvasAfterExternalApply({
        parsed: null,
        dirty: true,
        force: true,
      }),
    ).toEqual({ action: 'clear' });
  });

  it('replaces annotations from parsed doc', () => {
    const decision = decideCanvasAfterExternalApply({
      parsed,
      dirty: true,
      force: true,
    });
    expect(decision).toEqual({
      action: 'replace',
      annotations: parsed.annotations,
    });
  });
});
