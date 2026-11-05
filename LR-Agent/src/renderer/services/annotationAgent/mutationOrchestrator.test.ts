import type { AnnotationProjectSnapshot } from '../../../shared/annotationAgentTypes';
import type { BboxAnnotation } from '../../types/annotationDocument';
import { prepareMutationAnnotation } from '../annotationAgentApi';
import { updateAnnotationWorkspaceAgentSnapshot } from '../annotationAgentBridge';
import {
  runAnnotationMutationJob,
  type MutationProgressEvent,
} from './mutationOrchestrator';
import { readAnnotationsForPath } from './mutationTargetResolver';

jest.mock('../annotationAgentApi', () => ({
  prepareMutationAnnotation: jest.fn(),
}));

jest.mock('./mutationTargetResolver', () => ({
  ...jest.requireActual('./mutationTargetResolver'),
  readAnnotationsForPath: jest.fn(),
}));

const prepareMock = jest.mocked(prepareMutationAnnotation);
const readMock = jest.mocked(readAnnotationsForPath);
const project: AnnotationProjectSnapshot = {
  projectId: 'proj-1',
  name: 'Demo',
  directoryPath: 'C:/proj',
  modality: 'image',
  annotationType: 'bbox',
  labels: [
    { id: 'label-person', name: 'person', color: '#f00' },
    { id: 'label-car', name: 'car', color: '#0f0' },
  ],
  detectionModels: [],
};
const annotations: BboxAnnotation[] = ['ann-001', 'ann-002'].map((id) => ({
  id,
  kind: 'bbox',
  labelId: 'label-person',
  x: 0.1,
  y: 0.1,
  width: 0.2,
  height: 0.2,
  createdAt: '',
  updatedAt: '',
}));

function prepared(mutationKind: 'delete' | 'patch_label' = 'delete') {
  return {
    selected_paths: ['IMG_8167.JPG'],
    intent_summary: '修改选中框',
    operations: [
      {
        relative_path: 'IMG_8167.JPG',
        mutation_kind: mutationKind,
        targets: [{ by: 'selected' }],
        ...(mutationKind === 'patch_label' ? { new_label_name: 'car' } : {}),
      },
    ],
  };
}

async function run(selectedAnnotationIds: string[] | undefined = []) {
  const events: MutationProgressEvent[] = [];
  for await (const event of runAnnotationMutationJob({
    providerId: 'provider-1',
    userRequest: '修改选中框',
    project,
    currentFileAbsolutePath: 'C:/proj/IMG_8167.JPG',
    currentRelativePath: 'IMG_8167.JPG',
    candidates: [
      {
        relativePath: 'IMG_8167.JPG',
        absolutePath: 'C:/proj/IMG_8167.JPG',
        name: 'IMG_8167.JPG',
        parent: '',
        index: 0,
      },
    ],
    selectedAnnotationIds,
  })) {
    events.push(event);
  }
  const proposal = events.find(
    (event): event is Extract<MutationProgressEvent, { type: 'proposal' }> =>
      event.type === 'proposal',
  )?.proposal;
  return { events, proposal };
}

beforeEach(() => {
  jest.clearAllMocks();
  updateAnnotationWorkspaceAgentSnapshot({
    selectedAnnotationId: 'ann-001',
    selectedAnnotationIds: ['ann-001'],
    workspaceProjectId: 'proj-1',
    workspaceRelativePath: 'IMG_8167.JPG',
  });
  readMock.mockResolvedValue(annotations);
  prepareMock.mockResolvedValue(prepared());
});

afterEach(() => {
  updateAnnotationWorkspaceAgentSnapshot({
    selectedAnnotationId: null,
    selectedAnnotationIds: [],
    workspaceProjectId: null,
    workspaceRelativePath: null,
  });
});

it('deletes the selected annotation when tool IDs were parsed as an empty array', async () => {
  const { proposal } = await run([]);
  expect(prepareMock).toHaveBeenCalledWith(
    'provider-1',
    expect.objectContaining({ selectedAnnotationIds: ['ann-001'] }),
  );
  expect(proposal?.changes).toEqual([
    expect.objectContaining({ operation: 'delete', deleteIds: ['ann-001'] }),
  ]);
});

it('changes the label of the selected annotation without changing other boxes', async () => {
  prepareMock.mockResolvedValue(prepared('patch_label'));
  const { proposal } = await run();
  expect(proposal?.changes).toEqual([
    expect.objectContaining({
      operation: 'patch',
      patches: [{ id: 'ann-001', labelId: 'label-car' }],
    }),
  ]);
});

it('keeps the original target when selection changes while preparing', async () => {
  prepareMock.mockImplementation(async () => {
    updateAnnotationWorkspaceAgentSnapshot({
      selectedAnnotationId: 'ann-002',
      selectedAnnotationIds: ['ann-002'],
    });
    return prepared();
  });
  const { proposal } = await run();
  expect(proposal?.changes[0].deleteIds).toEqual(['ann-001']);
});

it('uses explicit tool IDs ahead of the canvas selection', async () => {
  const { proposal } = await run(['ann-002']);
  expect(prepareMock).toHaveBeenCalledWith(
    'provider-1',
    expect.objectContaining({ selectedAnnotationIds: ['ann-002'] }),
  );
  expect(proposal?.changes[0].deleteIds).toEqual(['ann-002']);
});

it('supports the single selected-ID field when the snapshot list is empty', async () => {
  updateAnnotationWorkspaceAgentSnapshot({ selectedAnnotationIds: [] });
  const { proposal } = await run();
  expect(proposal?.changes[0].deleteIds).toEqual(['ann-001']);
});

it.each([
  { workspaceProjectId: 'another-project' },
  { workspaceRelativePath: 'another.jpg' },
  { selectedAnnotationId: null, selectedAnnotationIds: [] },
])(
  'does not delete a different target when selection is unavailable: %j',
  async (patch) => {
    updateAnnotationWorkspaceAgentSnapshot(patch);
    const { proposal } = await run();
    expect(prepareMock).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({ selectedAnnotationIds: [] }),
    );
    expect(proposal).toBeUndefined();
  },
);
