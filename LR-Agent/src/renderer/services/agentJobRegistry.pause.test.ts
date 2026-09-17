/**
 * HITL 断点测试：客户端工具生成待确认提案时 job 暂停（AwaitingConfirm），
 * resumeAwaitingConfirmation 携带累积结果与刷新后的 clientContext 续跑。
 */
import type {
  AgentSession,
  ClientContextPayload,
  StreamEvent,
} from '../../shared/agentTypes';
import { JobState } from '../../shared/agentTypes';
import type { AnnotationProjectSnapshot } from '../../shared/annotationAgentTypes';

import { streamChatViaBackend } from './backendChatClient';
import { startAnnotationBatchJob } from './annotationBatchJob';
import {
  discardAwaitingConfirmation,
  getJobState,
  parseStringList,
  resumeAwaitingConfirmation,
  startChatJob,
  subscribeJobEvents,
  toolResultHasPendingProposal,
} from './agentJobRegistry';

jest.mock('./backendChatClient', () => {
  const actual = jest.requireActual('./backendChatClient');
  return {
    ...actual,
    streamChatViaBackend: jest.fn(),
  };
});

jest.mock('./annotationBatchJob', () => ({
  startAnnotationBatchJob: jest.fn(),
}));

jest.mock('./annotationMutationBatchJob', () => ({
  startAnnotationMutationJob: jest.fn(),
}));

const streamMock = streamChatViaBackend as unknown as jest.Mock;
const batchMock = startAnnotationBatchJob as unknown as jest.Mock;

function makeSession(id: string): AgentSession {
  return {
    id,
    title: 't',
    providerId: 'p',
    model: 'm',
    messageIds: [],
    createdAt: 1,
    updatedAt: 1,
  } as AgentSession;
}

const clientContext = {
  workspaceRoot: '/w',
  agentMode: 'annotation',
  workMode: 'annotation',
  activeAnnotationProjectId: 'proj',
} as ClientContextPayload;

const clientToolContext = {
  project: {
    projectId: 'proj',
    name: 'p',
    directoryPath: '/p',
    labels: [],
  } as unknown as AnnotationProjectSnapshot,
  detectionModels: [],
  currentFileAbsolutePath: null,
};

function setupStreamMock() {
  let call = 0;
  streamMock.mockImplementation(async function* () {
    call += 1;
    if (call === 1) {
      yield {
        type: 'tool_pending',
        toolCalls: [
          {
            toolCallId: 'tc1',
            name: 'auto_annotate',
            arguments: { user_request: '补标', paths: ['data/2.jpg'] },
          },
        ],
      };
      return;
    }
    yield { type: 'text_delta', content: '已核对并生成报告。' };
    yield { type: 'done' };
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  setupStreamMock();
});

afterEach(() => {
  // 清理模块级 job 注册表，避免暂停的 job 泄漏到后续用例
  discardAwaitingConfirmation('sess-1');
  discardAwaitingConfirmation('sess-2');
  discardAwaitingConfirmation('sess-3');
});

describe('parseStringList', () => {
  it('keeps arrays and single path strings', () => {
    expect(parseStringList(['data/4.jpg', ' data/5.jpg '])).toEqual([
      'data/4.jpg',
      'data/5.jpg',
    ]);
    expect(parseStringList('data/4.jpg')).toEqual(['data/4.jpg']);
  });

  it('parses JSON-encoded array strings from models', () => {
    expect(parseStringList('["data/4.jpg"]')).toEqual(['data/4.jpg']);
    expect(
      parseStringList(
        '["a1cf7b82-989e-4d91-b009-e83c0ddbfac0", "a5c8ab25-a442-4f1a-880e-fcf4332a3c18"]',
      ),
    ).toEqual([
      'a1cf7b82-989e-4d91-b009-e83c0ddbfac0',
      'a5c8ab25-a442-4f1a-880e-fcf4332a3c18',
    ]);
  });
});

describe('toolResultHasPendingProposal', () => {
  it('detects proposal_pending flag in result JSON', () => {
    expect(toolResultHasPendingProposal('{"proposal_pending":true}')).toBe(
      true,
    );
    expect(toolResultHasPendingProposal('{"proposal_pending":false}')).toBe(
      false,
    );
    expect(toolResultHasPendingProposal('not json')).toBe(false);
  });
});

describe('HITL 断点', () => {
  it('提案待确认时暂停 job，不自动 resume', async () => {
    batchMock.mockResolvedValue({
      status: 'completed',
      summary: '批量标注完成：处理 1 张，共 1 个框。',
      processedImages: 1,
      hasProposal: true,
      fileStats: [
        {
          path: 'data/2.jpg',
          operation: 'append',
          added: 1,
          deleted: 0,
          modified: 0,
          labels: ['斯蒂芬库里'],
        },
      ],
    });

    const events: StreamEvent[] = [];
    subscribeJobEvents('job-1', (e) => events.push(e));

    await startChatJob({
      jobId: 'job-1',
      session: makeSession('sess-1'),
      messageIds: [],
      sessionMessages: {},
      providerId: 'p',
      providerBaseUrl: 'http://x',
      providerApiKey: 'k',
      providerModel: 'm',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      userContent: '补标 data/2.jpg',
      clientContext,
      clientToolContext,
    });

    // 暂停：发出 awaiting_confirmation，job 保留在注册表，未发起第二轮流
    expect(events.some((e) => e.type === 'awaiting_confirmation')).toBe(true);
    expect(getJobState('job-1')).toBe(JobState.AwaitingConfirm);
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('resumeAwaitingConfirmation 携带结果与刷新上下文续跑', async () => {
    batchMock.mockResolvedValue({
      status: 'completed',
      summary: '批量标注完成：处理 1 张，共 1 个框。',
      processedImages: 1,
      hasProposal: true,
      fileStats: [
        {
          path: 'data/2.jpg',
          operation: 'append',
          added: 1,
          deleted: 0,
          modified: 0,
          labels: ['斯蒂芬库里'],
        },
      ],
    });
    const refreshClientContext = jest.fn().mockResolvedValue({
      ...clientContext,
      proposalStates: [
        { path: 'data/2.jpg', kind: 'annotation', status: 'applied' },
      ],
    });

    const events: StreamEvent[] = [];
    subscribeJobEvents('job-2', (e) => events.push(e));

    await startChatJob({
      jobId: 'job-2',
      session: makeSession('sess-1'),
      messageIds: [],
      sessionMessages: {},
      providerId: 'p',
      providerBaseUrl: 'http://x',
      providerApiKey: 'k',
      providerModel: 'm',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      userContent: '补标 data/2.jpg',
      clientContext,
      clientToolContext,
      refreshClientContext,
    });
    expect(getJobState('job-2')).toBe(JobState.AwaitingConfirm);

    const resumedJobId = resumeAwaitingConfirmation('sess-1');
    expect(resumedJobId).toBe('job-2');

    await waitFor(() => events.some((e) => e.type === 'done'));

    // 第二轮流携带 clientToolResults，且 clientContext 已刷新
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(refreshClientContext).toHaveBeenCalled();
    const secondCallArgs = streamMock.mock.calls[1][0] as {
      clientToolResults?: Array<{ name: string; result: string }>;
      clientContext?: ClientContextPayload;
    };
    expect(secondCallArgs.clientToolResults).toHaveLength(1);
    expect(secondCallArgs.clientToolResults?.[0].name).toBe('auto_annotate');
    const resultJson = JSON.parse(
      secondCallArgs.clientToolResults?.[0].result ?? '{}',
    ) as {
      proposal_pending?: boolean;
      files?: Array<{ path: string; added: number }>;
    };
    expect(resultJson.proposal_pending).toBe(true);
    expect(resultJson.files?.[0].path).toBe('data/2.jpg');
    expect(resultJson.files?.[0].added).toBe(1);
    expect(secondCallArgs.clientContext?.proposalStates?.[0].status).toBe(
      'applied',
    );

    // 续跑完成后 job 从注册表清除
    await waitFor(() => getJobState('job-2') === null);
  });

  it('无待确认提案时保持自动 resume（旧行为）', async () => {
    batchMock.mockResolvedValue({
      status: 'skipped',
      summary: '批量标注未产生提案。',
      processedImages: 0,
      hasProposal: false,
    });

    const events: StreamEvent[] = [];
    subscribeJobEvents('job-3', (e) => events.push(e));

    await startChatJob({
      jobId: 'job-3',
      session: makeSession('sess-2'),
      messageIds: [],
      sessionMessages: {},
      providerId: 'p',
      providerBaseUrl: 'http://x',
      providerApiKey: 'k',
      providerModel: 'm',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      userContent: '补标 data/2.jpg',
      clientContext,
      clientToolContext,
    });

    // 自动 resume：两轮流，无 awaiting_confirmation
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === 'awaiting_confirmation')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('discardAwaitingConfirmation 丢弃挂起 job', async () => {
    batchMock.mockResolvedValue({
      status: 'completed',
      summary: '批量标注完成：处理 1 张，共 1 个框。',
      processedImages: 1,
      hasProposal: true,
    });

    subscribeJobEvents('job-4', () => undefined);
    await startChatJob({
      jobId: 'job-4',
      session: makeSession('sess-3'),
      messageIds: [],
      sessionMessages: {},
      providerId: 'p',
      providerBaseUrl: 'http://x',
      providerApiKey: 'k',
      providerModel: 'm',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      userContent: '补标',
      clientContext,
      clientToolContext,
    });
    expect(getJobState('job-4')).toBe(JobState.AwaitingConfirm);

    discardAwaitingConfirmation('sess-3');
    expect(getJobState('job-4')).toBeNull();
    // 丢弃后 resume 无效果
    expect(resumeAwaitingConfirmation('sess-3')).toBeNull();
  });
});
