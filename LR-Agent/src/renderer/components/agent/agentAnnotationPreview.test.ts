import { describe, expect, it, jest } from '@jest/globals';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import type { AnnotationProject } from '../../types/annotation';
import {
  buildFileChangesFromProposal,
  isAgentPreviewPathMatch,
  requestOpenAnnotationPreview,
} from './agentAnnotationPreview';

describe('buildFileChangesFromProposal', () => {
  const proposal: AnnotationBatchProposal = {
    id: 'p1',
    projectId: 'proj1',
    summary: 'test',
    createdAt: 1,
    changes: [
      {
        relativePath: 'a.txt',
        absolutePath: '/tmp/a.txt',
        operation: 'append',
        annotations: [],
      },
      {
        relativePath: 'b.txt',
        absolutePath: '/tmp/b.txt',
        operation: 'append',
        annotations: [],
      },
      {
        relativePath: 'a.txt',
        absolutePath: '/tmp/a.txt',
        operation: 'append',
        annotations: [],
      },
    ],
    stats: { kind: 'generic', processed: 2, succeeded: 2, skipped: 0 },
  };

  it('filters changes by relative path preserving order', () => {
    const changes = buildFileChangesFromProposal(proposal, 'a.txt');
    expect(changes).toHaveLength(2);
    expect(changes.every((change) => change.relativePath === 'a.txt')).toBe(
      true,
    );
  });
});

describe('isAgentPreviewPathMatch', () => {
  it('matches synthetic path in freeform workspace', () => {
    expect(isAgentPreviewPathMatch('_synthetic_/1_cot.json', null)).toBe(true);
  });

  it('matches regular file paths exactly', () => {
    expect(isAgentPreviewPathMatch('data/a.txt', 'data/a.txt')).toBe(true);
    expect(isAgentPreviewPathMatch('data/a.txt', 'data/b.txt')).toBe(false);
  });
});

describe('requestOpenAnnotationPreview', () => {
  const project = {
    id: 'proj1',
    name: 'Demo',
    directoryPath: '/proj',
    modality: 'image',
    annotationType: 'bbox',
    labels: [],
    createdAt: '',
    updatedAt: '',
  } as AnnotationProject;

  const proposal: AnnotationBatchProposal = {
    id: 'p1',
    projectId: 'proj1',
    summary: 'test',
    createdAt: 1,
    changes: [
      {
        relativePath: 'images/a.jpg',
        absolutePath: '/proj/images/a.jpg',
        operation: 'append',
        annotations: [
          {
            id: 'ann-1',
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
      },
    ],
    stats: {
      kind: 'bbox',
      processed: 1,
      succeeded: 1,
      skipped: 0,
      totalBoxes: 1,
    },
  };

  it('uses immediate preview when pending on the currently open file', () => {
    const schedulePendingAgentNavigation = jest.fn();
    const applyImmediateAnnotationPreview = jest.fn(() => true);
    const openFileInEditor = jest.fn();
    const setWorkMode = jest.fn();

    const ok = requestOpenAnnotationPreview(
      {
        relativePath: 'images/a.jpg',
        absolutePath: '/proj/images/a.jpg',
        annotationId: 'ann-1',
        status: 'pending',
        proposal,
      },
      {
        activeProject: project,
        rootPath: '/proj',
        workspaceRelativePath: 'images/a.jpg',
        setWorkMode,
        openFileInEditor,
        schedulePendingAgentNavigation,
        applyImmediateAnnotationPreview,
        enterAgentPreview: jest.fn(),
        selectAnnotation: jest.fn(),
        setTool: jest.fn(),
        loadSyntheticAnnotationForView: async () => {},
      },
    );

    expect(ok).toBe(true);
    expect(applyImmediateAnnotationPreview).toHaveBeenCalledWith({
      relativePath: 'images/a.jpg',
      annotationId: 'ann-1',
      proposal,
      proposalAnchorId: undefined,
      status: 'pending',
    });
    expect(schedulePendingAgentNavigation).not.toHaveBeenCalled();
    expect(openFileInEditor).toHaveBeenCalledWith('/proj/images/a.jpg');
  });

  it('falls back to pending navigation for a different file', () => {
    const schedulePendingAgentNavigation = jest.fn();
    const applyImmediateAnnotationPreview = jest.fn(() => false);

    requestOpenAnnotationPreview(
      {
        relativePath: 'images/b.jpg',
        absolutePath: '/proj/images/b.jpg',
        annotationId: 'ann-2',
        status: 'pending',
        proposal,
      },
      {
        activeProject: project,
        rootPath: '/proj',
        workspaceRelativePath: 'images/a.jpg',
        setWorkMode: jest.fn(),
        openFileInEditor: jest.fn(),
        schedulePendingAgentNavigation,
        applyImmediateAnnotationPreview,
        enterAgentPreview: jest.fn(),
        selectAnnotation: jest.fn(),
        setTool: jest.fn(),
        loadSyntheticAnnotationForView: async () => {},
      },
    );

    expect(schedulePendingAgentNavigation).toHaveBeenCalled();
  });
});
