import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { usePretrainedModels } from '../../context/PretrainedModelsContext';
import { useToast } from '../../context/ToastContext';
import { runPreAnnot } from '../../services/preAnnotService';
import type { LabelDefinition } from '../../types/annotation';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import PreAnnotToolbarSection from './PreAnnotToolbarSection';

jest.mock('../../context/AnnotationContext', () => ({
  useAnnotation: jest.fn(),
}));
jest.mock('../../context/AnnotationWorkspaceContext', () => ({
  useAnnotationWorkspace: jest.fn(),
}));
jest.mock('../../context/PretrainedModelsContext', () => ({
  usePretrainedModels: jest.fn(),
}));
jest.mock('../../context/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../../services/preAnnotService', () => ({
  ...jest.requireActual('../../services/preAnnotService'),
  runPreAnnot: jest.fn(),
}));

const projectLabel: LabelDefinition = {
  id: 'project-label-1',
  name: 'label',
  color: '#0f0',
};
const otherLabel: LabelDefinition = {
  id: 'project-label-2',
  name: 'other',
  color: '#f00',
};
const model: PretrainedModelConfig = {
  id: 'yolo-model-1',
  name: 'label',
  modelType: 'object_detection',
  enabled: true,
  isDefault: true,
  checkpointPath: 'C:/models/custom.pt',
  detectionMode: 'detect',
  createdAt: '',
  updatedAt: '',
};
const addBboxes = jest.fn((items: unknown[]) => items.length);
const addRotatedBboxes = jest.fn((items: unknown[]) => items.length);
const showToast = jest.fn();

function setup(options?: {
  labels?: LabelDefinition[];
  mode?: 'bbox' | 'rotated_bbox';
  className?: string;
  labelMapping?: Record<string, string>;
}) {
  const labels = options?.labels ?? [projectLabel];
  const mode = options?.mode ?? 'bbox';
  const selectedModel = {
    ...model,
    detectionMode: mode === 'bbox' ? ('detect' as const) : ('obb' as const),
    labelMapping: options?.labelMapping,
  };
  jest.mocked(useAnnotation).mockReturnValue({
    activeProject: { id: 'proj-1', labels },
  } as ReturnType<typeof useAnnotation>);
  jest.mocked(useAnnotationWorkspace).mockReturnValue({
    activeTemplateId: 'person_coco',
    activeLabelId: projectLabel.id,
    setTool: jest.fn(),
    addPreAnnotBboxes: addBboxes,
    addPreAnnotRotatedBboxes: addRotatedBboxes,
    addPreAnnotPoses: jest.fn(),
    clearPreAnnots: jest.fn(),
  } as unknown as ReturnType<typeof useAnnotationWorkspace>);
  jest.mocked(usePretrainedModels).mockReturnValue({
    models: [selectedModel],
    loading: false,
  } as ReturnType<typeof usePretrainedModels>);
  jest
    .mocked(useToast)
    .mockReturnValue({ showToast } as ReturnType<typeof useToast>);
  jest.mocked(runPreAnnot).mockResolvedValue({
    ok: true,
    result: {
      items: [
        {
          className: options?.className ?? 'detected-logo',
          classId: 0,
          confidence: 0.98,
          geometry:
            mode === 'bbox'
              ? { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }
              : { cx: 0.3, cy: 0.2, width: 0.3, height: 0.1, angle: 20 },
        },
      ],
    },
  });

  render(<PreAnnotToolbarSection mode={mode} imagePath="C:/proj/a.jpg" />);
  return mode === 'bbox' ? addBboxes : addRotatedBboxes;
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});

it.each(['bbox', 'rotated_bbox'] as const)(
  'assigns the sole project label after clicking generate in %s mode',
  async (mode) => {
    const add = setup({ mode });
    fireEvent.click(screen.getByText('生成预标注'));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add).toHaveBeenCalledWith([
      expect.objectContaining({ labelId: 'project-label-1' }),
    ]);
  },
);

it('uses configured detection-class mapping in a multi-label project', async () => {
  const add = setup({
    labels: [projectLabel, otherLabel],
    labelMapping: { 'detected-logo': 'project-label-2' },
  });
  fireEvent.click(screen.getByText('生成预标注'));
  await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
  expect(add).toHaveBeenCalledWith([
    expect.objectContaining({ labelId: 'project-label-2' }),
  ]);
});

it('matches detection class names to project label names', async () => {
  const add = setup({
    labels: [projectLabel, otherLabel],
    className: ' OTHER ',
  });
  fireEvent.click(screen.getByText('生成预标注'));
  await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
  expect(add).toHaveBeenCalledWith([
    expect.objectContaining({ labelId: 'project-label-2' }),
  ]);
});

it('does not use the model display name or active drawing label to guess unmatched classes', async () => {
  const add = setup({
    labels: [projectLabel, otherLabel],
    labelMapping: { 'detected-logo': 'deleted-label-id' },
  });
  fireEvent.click(screen.getByText('生成预标注'));
  await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
  expect(add).toHaveBeenCalledWith([
    expect.objectContaining({ labelId: null }),
  ]);
});
