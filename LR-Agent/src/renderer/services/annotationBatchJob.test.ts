import { describe, expect, it, jest } from '@jest/globals';
import type {
  AnnotationBatchProposal,
  AnnotationProjectSnapshot,
} from '../../shared/annotationAgentTypes';
import type { StreamEvent } from '../../shared/agentTypes';
import { runAnnotationBatchJob } from './annotationAgent/batchOrchestrator';
import type { AnnotationProgressEvent } from './annotationAgent/batchOrchestrator';
import { startAnnotationBatchJob } from './annotationBatchJob';

jest.mock('./annotationAgent/batchOrchestrator', () => ({
  runAnnotationBatchJob: jest.fn(),
}));

const mockedRun = jest.mocked(runAnnotationBatchJob);

const project: AnnotationProjectSnapshot = {
  projectId: 'proj-1',
  name: 'Demo',
  directoryPath: 'C:/proj',
  modality: 'text',
  annotationType: 'text_classification',
  labels: [{ id: 'l1', name: '官方通知', color: '#f00' }],
  detectionModels: [],
};

function buildProposal(): AnnotationBatchProposal {
  return {
    id: 'p1',
    projectId: 'proj-1',
    summary: '批量文本分类标注生成：1 项，共 2 条',
    changes: [
      {
        relativePath: 'a.txt',
        absolutePath: 'C:/proj/a.txt',
        operation: 'append',
        annotations: [],
      },
    ],
    stats: { kind: 'generic', processed: 1, succeeded: 1, skipped: 0 },
    createdAt: Date.now(),
  };
}

function mockPipeline(events: AnnotationProgressEvent[]): void {
  mockedRun.mockImplementationOnce(async function* () {
    for (const event of events) {
      yield event;
    }
  });
}

async function runJob() {
  const emitted: StreamEvent[] = [];
  return {
    result: await startAnnotationBatchJob({
      jobId: 'job-1',
      providerId: 'provider-1',
      userRequest: '对所有文件进行标注',
      project,
      currentFileAbsolutePath: null,
      detectionModels: [],
      onEvent: (event) => emitted.push(event),
      signal: new AbortController().signal,
    }),
    emitted,
  };
}

describe('startAnnotationBatchJob status', () => {
  afterEach(() => {
    mockedRun.mockReset();
  });

  it('restores completed status when text arrives before proposal', async () => {
    mockPipeline([
      { type: 'text', content: '已生成 2 条文本分类标注数据（1 项）。' },
      { type: 'proposal', proposal: buildProposal() },
    ]);

    const { result } = await runJob();

    expect(result.status).toBe('completed');
    expect(result.hasProposal).toBe(true);
    expect(result.summary).toContain('批量标注完成');
    expect(result.summary).toContain('处理 1 张');
  });

  it('keeps skipped status when only text is emitted without proposal', async () => {
    mockPipeline([{ type: 'text', content: '未识别为批量标注请求。' }]);

    const { result } = await runJob();

    expect(result.status).toBe('skipped');
    expect(result.hasProposal).toBe(false);
    expect(result.summary).toContain('未识别为批量标注请求');
  });

  it('marks error on pipeline error event', async () => {
    mockPipeline([{ type: 'error', message: '流水线失败' }]);

    const { result, emitted } = await runJob();

    expect(result.status).toBe('error');
    expect(result.summary).toBe('流水线失败');
    expect(emitted.some((event) => event.type === 'error')).toBe(false);
    expect(emitted.some((event) => event.type === 'done')).toBe(false);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'annotation_progress',
          status: 'error',
          message: '流水线失败',
        }),
      ]),
    );
  });

  it('captures omitted files from scope_truncated', async () => {
    mockPipeline([
      {
        type: 'scope_truncated',
        omittedCount: 37,
        omittedPaths: ['data/101.jpg'],
      },
      { type: 'proposal', proposal: buildProposal() },
    ]);

    const { result, emitted } = await runJob();

    expect(result.omittedCount).toBe(37);
    expect(result.omittedPaths).toEqual(['data/101.jpg']);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'annotation_progress',
          message: expect.stringContaining('另有 37 张未纳入'),
        }),
      ]),
    );
  });

  it('does not emit chat-level done after a successful proposal', async () => {
    mockPipeline([
      { type: 'text', content: '已生成 2 条文本分类标注数据（1 项）。' },
      { type: 'proposal', proposal: buildProposal() },
    ]);

    const { emitted } = await runJob();

    expect(emitted.some((event) => event.type === 'done')).toBe(false);
  });
});
