import type { BboxAnnotation } from '../types/annotationDocument';
import type { AnnotationBatchChange } from '../../shared/annotationAgentTypes';
import { overlayPendingAnnotations } from './pendingAnnotationOverlay';
import { resolveMutationTargets } from './annotationAgent/mutationTargetResolver';

const labeled: BboxAnnotation = {
  id: 'a',
  kind: 'bbox',
  labelId: 'face',
  x: 0.1,
  y: 0.1,
  width: 0.2,
  height: 0.2,
  createdAt: '',
  updatedAt: '',
};

const unlabeled: BboxAnnotation = {
  id: 'unlabeled-1',
  kind: 'bbox',
  labelId: null,
  x: 0,
  y: 0.5,
  width: 0.16,
  height: 0.46,
  createdAt: '',
  updatedAt: '',
};

const pendingAppend: AnnotationBatchChange = {
  relativePath: 'data/8.jpg',
  absolutePath: '/p/data/8.jpg',
  operation: 'append',
  annotations: [labeled, unlabeled],
};

describe('overlayPendingAnnotations', () => {
  it('overlays pending append onto empty disk and resolves unlabeled delete', () => {
    const working = overlayPendingAnnotations(
      [],
      'data/8.jpg',
      [pendingAppend],
      { id: 'proj', modality: 'image', annotationType: 'bbox' },
    );
    expect(working.map((ann) => ann.id)).toEqual(['a', 'unlabeled-1']);

    const { ids } = resolveMutationTargets(
      working,
      [{ by: 'unlabeled' }],
      [{ id: 'face', name: 'face', color: '#f00' }],
      [],
    );
    expect(ids).toEqual(['unlabeled-1']);
  });

  it('ignores changes for other paths', () => {
    const working = overlayPendingAnnotations(
      [labeled],
      'data/8.jpg',
      [
        {
          ...pendingAppend,
          relativePath: 'data/9.jpg',
        },
      ],
      { id: 'proj', modality: 'image', annotationType: 'bbox' },
    );
    expect(working).toEqual([labeled]);
  });
});
