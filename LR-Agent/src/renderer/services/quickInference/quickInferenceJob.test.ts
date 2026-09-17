import { describe, expect, it, jest } from '@jest/globals';
import type {
  AnnotationPipelineStep,
  LlmProviderConfig,
  StreamEvent,
} from '../../../shared/agentTypes';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import type { AnnotationProject } from '../../types/annotation';
import { startAnnotationBatchJob } from '../annotationBatchJob';
import { runQuickInferenceJob } from './quickInferenceJob';

jest.mock('../annotationBatchJob', () => ({
  startAnnotationBatchJob: jest.fn(),
}));
jest.mock('../buildProjectSnapshot', () => ({
  buildAnnotationProjectSnapshot: jest.fn(() => ({})),
}));

const mockedStart = jest.mocked(startAnnotationBatchJob);

const provider: LlmProviderConfig = {
  id: 'provider-1',
  name: 'Demo',
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  model: 'demo-model',
  enabled: true,
  isDefault: true,
  supportsVision: false,
  visionProbedAt: null,
  visionProbeDetail: '',
  contextWindowTokens: null,
  contextWindowSource: '',
  createdAt: 0,
  updatedAt: 0,
};

const project: AnnotationProject = {
  id: 'proj-1',
  name: 'Demo',
  directoryPath: 'C:/proj',
  modality: 'image',
  annotationType: 'bbox',
  labels: [{ id: 'l1', name: 'car', color: '#f00' }],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

function buildProposal(): AnnotationBatchProposal {
  return {
    id: 'p1',
    projectId: 'proj-1',
    summary: '矩形框批量标注：1 张图片，共 1 个实例',
    changes: [
      {
        relativePath: 'a.jpg',
        absolutePath: 'C:/proj/a.jpg',
        operation: 'append',
        annotations: [],
      },
    ],
    stats: {
      kind: 'geometry',
      processed: 1,
      succeeded: 1,
      skipped: 0,
      totalInstances: 1,
      cancelled: false,
    },
    createdAt: Date.now(),
  };
}

/** 让被 mock 的 startAnnotationBatchJob 依次派发事件并返回成功结果。 */
function mockJob(events: StreamEvent[]): void {
  mockedStart.mockImplementationOnce(async (args) => {
    for (const event of events) {
      args.onEvent(event);
    }
    return {
      status: 'completed',
      summary: '批量标注完成',
      processedImages: 1,
      hasProposal: true,
    };
  });
}

async function runJob(events: StreamEvent[]) {
  mockJob(events);
  const updates: AnnotationPipelineStep[][] = [];
  const result = await runQuickInferenceJob({
    provider,
    project,
    detectionModels: [],
    currentFileAbsolutePath: 'C:/proj/a.jpg',
    scopeHint: 'a.jpg',
    onPipelineUpdate: (steps) => updates.push(steps),
    signal: new AbortController().signal,
  });
  return { result, updates };
}

describe('runQuickInferenceJob pipeline finalize', () => {
  afterEach(() => {
    mockedStart.mockReset();
  });

  it('finalizes running main + worker steps when proposal arrives', async () => {
    const { result, updates } = await runJob([
      {
        type: 'annotation_progress',
        stage: 'prepare',
        message: '准备完成',
        status: 'done',
      },
      {
        type: 'annotation_progress',
        stage: 'workers',
        message: '共 1 张图片',
        status: 'running',
      },
      {
        type: 'annotation_progress',
        stage: 'worker',
        message: '处理中：a.jpg',
        status: 'running',
        imagePath: 'a.jpg',
      },
      { type: 'text_delta', content: '已处理 1 张图片。' },
      { type: 'annotation_proposal', proposal: buildProposal() },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 提案到达后不应残留 running/pending，否则面板会一直显示「批量标注进行中…」
    expect(result.pipelineSteps.some((step) => step.status === 'running')).toBe(
      false,
    );
    expect(
      result.pipelineSteps.find((step) => step.stage === 'workers')?.status,
    ).toBe('done');
    expect(
      result.pipelineSteps.find((step) => step.stage === 'worker')?.status,
    ).toBe('done');

    // 最后一次 onPipelineUpdate 必须携带收尾后的步骤，供面板同步刷新
    const last = updates[updates.length - 1];
    expect(last.some((step) => step.status === 'running')).toBe(false);
  });

  it('keeps running steps untouched when no proposal is produced', async () => {
    const { result } = await runJob([
      {
        type: 'annotation_progress',
        stage: 'workers',
        message: '共 1 张图片',
        status: 'running',
      },
    ]);

    expect(result.ok).toBe(false);
  });
});
