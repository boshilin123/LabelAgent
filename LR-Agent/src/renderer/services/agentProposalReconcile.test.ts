import type {
  FileAnnotationDocument,
  BboxAnnotation,
} from '../types/annotationDocument';
import type { AnnotationBatchChange } from '../../shared/annotationAgentTypes';
import { isAnnotationChangeAppliedOnDisk } from './agentProposalReconcile';

const box = (id: string, labelId: string | null = 'face'): BboxAnnotation => ({
  id,
  kind: 'bbox',
  labelId,
  x: 0.1,
  y: 0.1,
  width: 0.2,
  height: 0.2,
  createdAt: 't',
  updatedAt: 't',
});

function doc(annotations: BboxAnnotation[]): FileAnnotationDocument {
  return {
    schemaVersion: 1,
    projectId: 'proj',
    filePath: 'data/8.jpg',
    modality: 'image',
    annotationType: 'bbox',
    annotations,
    updatedAt: 't',
  };
}

describe('isAnnotationChangeAppliedOnDisk', () => {
  it('does not mark empty delete annotations as applied', () => {
    const change: AnnotationBatchChange = {
      relativePath: 'data/8.jpg',
      absolutePath: '/p/data/8.jpg',
      operation: 'delete',
      annotations: [],
    };
    expect(isAnnotationChangeAppliedOnDisk(change, doc([box('a')]))).toBe(
      false,
    );
    expect(isAnnotationChangeAppliedOnDisk(change, null)).toBe(false);
  });

  it('marks delete applied only when deleteIds are gone from disk', () => {
    const change: AnnotationBatchChange = {
      relativePath: 'data/8.jpg',
      absolutePath: '/p/data/8.jpg',
      operation: 'delete',
      deleteIds: ['unlabeled-1'],
    };
    expect(
      isAnnotationChangeAppliedOnDisk(
        change,
        doc([box('a'), box('unlabeled-1', null)]),
      ),
    ).toBe(false);
    expect(isAnnotationChangeAppliedOnDisk(change, doc([box('a')]))).toBe(true);
    expect(isAnnotationChangeAppliedOnDisk(change, null)).toBe(false);
  });

  it('marks append applied only when all proposal ids exist on disk', () => {
    const change: AnnotationBatchChange = {
      relativePath: 'data/8.jpg',
      absolutePath: '/p/data/8.jpg',
      operation: 'append',
      annotations: [box('a'), box('b')],
    };
    expect(isAnnotationChangeAppliedOnDisk(change, doc([box('a')]))).toBe(
      false,
    );
    expect(
      isAnnotationChangeAppliedOnDisk(change, doc([box('a'), box('b')])),
    ).toBe(true);
    expect(isAnnotationChangeAppliedOnDisk(change, null)).toBe(false);
    expect(
      isAnnotationChangeAppliedOnDisk(
        { ...change, annotations: [] },
        doc([box('a')]),
      ),
    ).toBe(false);
  });

  it('marks patch applied only when matching fields exist on disk', () => {
    const change: AnnotationBatchChange = {
      relativePath: 'data/8.jpg',
      absolutePath: '/p/data/8.jpg',
      operation: 'patch',
      patches: [{ id: 'a', labelId: 'face' }],
    };
    expect(
      isAnnotationChangeAppliedOnDisk(change, doc([box('a', 'car')])),
    ).toBe(false);
    expect(
      isAnnotationChangeAppliedOnDisk(change, doc([box('a', 'face')])),
    ).toBe(true);
    expect(isAnnotationChangeAppliedOnDisk(change, doc([box('b')]))).toBe(
      false,
    );
  });
});
