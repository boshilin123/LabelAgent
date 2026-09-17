/**
 * 终端命令客户端工具测试：批准 → 执行 → 输出流式回显 → 携带结果 resume；
 * 拒绝 → 不启动、以 skipped 结果立即 resume；门禁拒绝 → error 结果。
 */
import type {
  AgentSession,
  ClientContextPayload,
  StreamEvent,
} from '../../shared/agentTypes';
import type { AnnotationProjectSnapshot } from '../../shared/annotationAgentTypes';

import { streamChatViaBackend } from './backendChatClient';
import {
  discardAwaitingConfirmation,
  startChatJob,
  subscribeJobEvents,
} from './agentJobRegistry';
import { resolveTerminalApproval } from './terminalApproval';

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

function setupStreamWithTerminalCall() {
  // 首轮流派发终端工具；后续 resume 流正常收尾（否则会无限再次 pending）
  let call = 0;
  streamMock.mockImplementation(async function* () {
    call += 1;
    if (call === 1) {
      yield {
        type: 'tool_pending',
        toolCalls: [
          {
            toolCallId: 'tc-term',
            name: 'start_terminal_command',
            arguments: { command: 'git', args: ['status'] },
          },
        ],
      };
      return;
    }
    yield { type: 'text_delta', content: '命令完成。' };
    yield { type: 'done' };
  });
}

/** fake preload terminal 桥 */
function installFakeBridge(options?: {
  startResult?: { ok: false; error: string; message?: string };
}) {
  type Evt = {
    type: string;
    jobId?: string;
    chunk?: string;
    status?: string;
    exitCode?: number | null;
  };
  let listener: ((evt: Evt) => void) | null = null;
  let exitSent = false;
  const bridge = {
    start: jest.fn(async () => {
      if (options?.startResult) return options.startResult;
      // 模拟真实主进程时序：invoke 先返回 jobId，输出/终态事件随后到达
      // （注册表在 start 返回后才置 activeJobId，事件先于返回会被丢弃）
      await new Promise((r) => setTimeout(r, 10));
      setTimeout(() => {
        listener?.({ type: 'output', jobId: 'job-9', chunk: 'on main\n' });
        if (!exitSent) {
          exitSent = true;
          listener?.({
            type: 'exit',
            jobId: 'job-9',
            status: 'exited',
            exitCode: 0,
          });
        }
      }, 5);
      return { ok: true, jobId: 'job-9' };
    }),
    read: jest.fn(async () => ({
      ok: true,
      snapshot: {
        output: 'on main\n',
        truncated: false,
        status: 'exited',
        exitCode: 0,
      },
    })),
    kill: jest.fn(async () => true),
    onEvent: jest.fn((cb: (evt: Evt) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  };
  (window as unknown as { electron: { terminal: unknown } }).electron = {
    terminal: bridge,
  };
  return bridge;
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function lastClientToolResults(): Array<Record<string, unknown>> {
  const secondCall = streamMock.mock.calls[1]?.[0] as
    { clientToolResults?: Array<{ result: string }> } | undefined;
  return (secondCall?.clientToolResults ?? []).map((r) => JSON.parse(r.result));
}

describe('start_terminal_command 客户端工具', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupStreamWithTerminalCall();
  });

  afterEach(() => {
    discardAwaitingConfirmation('sess-term');
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('批准后执行：输出回显 + 结果携带 exit_code/job_id 并 resume', async () => {
    const bridge = installFakeBridge();
    const events: StreamEvent[] = [];
    subscribeJobEvents('job-term-1', (e) => events.push(e));

    const runPromise = startChatJob({
      jobId: 'job-term-1',
      session: makeSession('sess-term'),
      messageIds: [],
      sessionMessages: {},
      providerId: 'p',
      providerBaseUrl: 'http://x',
      providerApiKey: 'k',
      providerModel: 'm',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      userContent: '查看 git 状态',
      clientContext,
    });

    // 等待批准请求出现后批准
    await waitFor(() => events.some((e) => e.type === 'terminal_approval'));
    expect(bridge.start).not.toHaveBeenCalled();
    expect(resolveTerminalApproval('tc-term', true)).toBe(true);

    await waitFor(() => streamMock.mock.calls.length >= 2);
    await runPromise;
    expect(bridge.start).toHaveBeenCalledWith({
      command: 'git',
      args: ['status'],
      timeoutMs: undefined,
    });
    expect(events.some((e) => e.type === 'terminal_output')).toBe(true);
    expect(events.some((e) => e.type === 'terminal_approval_done')).toBe(true);

    const results = lastClientToolResults();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: 'completed',
      exit_code: 0,
      job_id: 'job-9',
    });
    expect(String(results[0].output_tail)).toContain('on main');
  }, 10_000);

  it('拒绝后不启动，以 skipped 结果立即 resume', async () => {
    const bridge = installFakeBridge();
    const events: StreamEvent[] = [];
    subscribeJobEvents('job-term-2', (e) => events.push(e));

    const runPromise = startChatJob({
      jobId: 'job-term-2',
      session: makeSession('sess-term'),
      messageIds: [],
      sessionMessages: {},
      providerId: 'p',
      providerBaseUrl: 'http://x',
      providerApiKey: 'k',
      providerModel: 'm',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      userContent: '查看 git 状态',
      clientContext,
    });

    await waitFor(() => events.some((e) => e.type === 'terminal_approval'));
    expect(resolveTerminalApproval('tc-term', false)).toBe(true);

    await waitFor(() => streamMock.mock.calls.length >= 2);
    await runPromise;
    expect(bridge.start).not.toHaveBeenCalled();
    expect(lastClientToolResults()[0]).toMatchObject({
      status: 'skipped',
      summary: '用户拒绝执行该命令',
    });
  }, 10_000);

  it('主进程门禁拒绝时返回 error 结果', async () => {
    installFakeBridge({
      startResult: { ok: false, error: 'denied_command' },
    });
    const events: StreamEvent[] = [];
    subscribeJobEvents('job-term-3', (e) => events.push(e));

    const runPromise = startChatJob({
      jobId: 'job-term-3',
      session: makeSession('sess-term'),
      messageIds: [],
      sessionMessages: {},
      providerId: 'p',
      providerBaseUrl: 'http://x',
      providerApiKey: 'k',
      providerModel: 'm',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      userContent: '危险命令',
      clientContext,
    });

    await waitFor(() => events.some((e) => e.type === 'terminal_approval'));
    expect(resolveTerminalApproval('tc-term', true)).toBe(true);

    await waitFor(() => streamMock.mock.calls.length >= 2);
    await runPromise;
    const result = lastClientToolResults()[0];
    expect(result).toMatchObject({
      status: 'error',
      message: 'denied_command',
    });
    expect(String(result.summary)).toContain('拒绝清单');
  }, 10_000);
});
