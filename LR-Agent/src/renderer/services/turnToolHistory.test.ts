import type { StreamEvent } from '../../shared/agentTypes';
import {
  TurnToolHistoryAccumulator,
  mergeResumeMessages,
} from './turnToolHistory';
import {
  buildBackendMessages,
  serializeBackendMessages,
} from './backendChatClient';

function text(content: string): StreamEvent {
  return { type: 'text_delta', content };
}

function toolStart(
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
): StreamEvent {
  return {
    type: 'tool_start',
    toolCallId,
    name,
    arguments: JSON.stringify(args),
  };
}

function toolResult(toolCallId: string, result: string): StreamEvent {
  return { type: 'tool_result', toolCallId, result };
}

describe('TurnToolHistoryAccumulator', () => {
  it('groups consecutive vision reads after commentary and leaves pending auto_annotate without a tool result', () => {
    const acc = new TurnToolHistoryAccumulator();
    acc.apply(text('我先预览第 6~8 张图片。'));
    acc.apply(
      toolStart('v1', 'read_image_for_vision', { relative_path: '6.jpg' }),
    );
    acc.apply(
      toolStart('v2', 'read_image_for_vision', { relative_path: '7.jpg' }),
    );
    acc.apply(
      toolStart('v3', 'read_image_for_vision', { relative_path: '8.jpg' }),
    );
    acc.apply(toolResult('v1', '{"ok":true,"name":"6.jpg"}'));
    acc.apply(toolResult('v2', '{"ok":true,"name":"7.jpg"}'));
    acc.apply(toolResult('v3', '{"ok":true,"name":"8.jpg"}'));
    acc.apply(text('三张图片已预览完毕，现在执行自动标注。'));
    acc.apply(
      toolStart('a1', 'auto_annotate', { user_request: '标注第 6~8 张' }),
    );
    acc.apply({
      type: 'tool_pending',
      toolCalls: [
        {
          toolCallId: 'a1',
          name: 'auto_annotate',
          arguments: { user_request: '标注第 6~8 张' },
        },
      ],
    });

    const snapshot = acc.snapshot();
    expect(snapshot).toEqual([
      {
        role: 'assistant',
        content: '我先预览第 6~8 张图片。',
        tool_calls: [
          {
            id: 'v1',
            name: 'read_image_for_vision',
            args: { relative_path: '6.jpg' },
          },
          {
            id: 'v2',
            name: 'read_image_for_vision',
            args: { relative_path: '7.jpg' },
          },
          {
            id: 'v3',
            name: 'read_image_for_vision',
            args: { relative_path: '8.jpg' },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"ok":true,"name":"6.jpg"}',
        tool_call_id: 'v1',
      },
      {
        role: 'tool',
        content: '{"ok":true,"name":"7.jpg"}',
        tool_call_id: 'v2',
      },
      {
        role: 'tool',
        content: '{"ok":true,"name":"8.jpg"}',
        tool_call_id: 'v3',
      },
      {
        role: 'assistant',
        content: '三张图片已预览完毕，现在执行自动标注。',
        tool_calls: [
          {
            id: 'a1',
            name: 'auto_annotate',
            args: { user_request: '标注第 6~8 张' },
          },
        ],
      },
    ]);
    expect(
      snapshot.some((m) => m.role === 'tool' && m.tool_call_id === 'a1'),
    ).toBe(false);
  });

  it('keeps separate LLM rounds as separate assistant messages', () => {
    const acc = new TurnToolHistoryAccumulator();
    acc.apply(toolStart('l1', 'list_workspace_directory', { path: '.' }));
    acc.apply(toolResult('l1', 'Explored 1 listing'));
    acc.apply(toolStart('m1', 'memory_read', { topic_file: 'progress.md' }));
    acc.apply(toolResult('m1', '# progress'));

    const snapshot = acc.snapshot();
    expect(snapshot.map((m) => m.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'tool',
    ]);
    expect(snapshot[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'l1', name: 'list_workspace_directory' }],
    });
    expect(snapshot[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'm1', name: 'memory_read' }],
    });
  });

  it('does not treat trailing commentary as an empty streaming assistant placeholder', () => {
    const acc = new TurnToolHistoryAccumulator();
    acc.apply(text('先看目录。'));
    acc.apply(toolStart('l1', 'list_workspace_directory', {}));
    acc.apply(toolResult('l1', 'ok'));
    acc.apply(text('  '));
    expect(acc.snapshot()).toHaveLength(2);
  });
});

describe('mergeResumeMessages', () => {
  it('appends this-turn tool history after prior user/assistant text', () => {
    const prior = [{ role: 'user', content: '标注第 6~8 张并更新记忆' }];
    const acc = new TurnToolHistoryAccumulator();
    acc.apply(text('先预览。'));
    acc.apply(
      toolStart('v1', 'read_image_for_vision', { relative_path: '6.jpg' }),
    );
    acc.apply(toolResult('v1', '{"ok":true}'));
    const merged = mergeResumeMessages(prior, acc.snapshot());
    expect(merged[0]).toEqual(prior[0]);
    expect(merged).toHaveLength(3);
    expect(merged[1]).toMatchObject({
      role: 'assistant',
      content: '先预览。',
    });
    expect(merged[2]).toMatchObject({ role: 'tool', tool_call_id: 'v1' });
  });
});

describe('buildBackendMessages', () => {
  it('excludes the current streaming assistant placeholder', () => {
    const sessionMessages = {
      u1: {
        id: 'u1',
        sessionId: 's',
        role: 'user' as const,
        blocks: [{ type: 'text' as const, content: '标注第 6 张' }],
        status: 'done' as const,
        providerId: 'p',
        model: 'm',
        createdAt: 1,
        updatedAt: 1,
      },
      a1: {
        id: 'a1',
        sessionId: 's',
        role: 'assistant' as const,
        blocks: [],
        status: 'streaming' as const,
        providerId: 'p',
        model: 'm',
        createdAt: 2,
        updatedAt: 2,
      },
    };
    const messages = buildBackendMessages(['u1', 'a1'], sessionMessages, {
      excludeMessageIds: new Set(['a1']),
    });
    expect(messages).toEqual([{ role: 'user', content: '标注第 6 张' }]);
  });

  it('restores annotation tool pairs from prior assistant blocks', () => {
    const sessionMessages = {
      u1: {
        id: 'u1',
        sessionId: 's',
        role: 'user' as const,
        blocks: [{ type: 'text' as const, content: '标 8.jpg' }],
        status: 'done' as const,
        providerId: 'p',
        model: 'm',
        createdAt: 1,
        updatedAt: 1,
      },
      a1: {
        id: 'a1',
        sessionId: 's',
        role: 'assistant' as const,
        blocks: [
          { type: 'text' as const, content: '已处理 1 张图片' },
          {
            type: 'tool_call' as const,
            id: 'call-aa',
            name: 'auto_annotate',
            arguments: '{"user_request":"标 8.jpg","paths":["data/8.jpg"]}',
            status: 'done' as const,
            result:
              '{"status":"completed","summary":"ok","proposal_pending":true,"file_written":false}',
            collapsed: true,
          },
        ],
        status: 'done' as const,
        providerId: 'p',
        model: 'm',
        createdAt: 2,
        updatedAt: 2,
      },
    };
    const messages = buildBackendMessages(['u1', 'a1'], sessionMessages);
    expect(messages[0]).toEqual({ role: 'user', content: '标 8.jpg' });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: '已处理 1 张图片',
      tool_calls: [
        {
          id: 'call-aa',
          name: 'auto_annotate',
          args: { user_request: '标 8.jpg', paths: ['data/8.jpg'] },
        },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-aa',
    });
    expect(JSON.parse(messages[2].content).proposal_pending).toBe(true);
  });
});

describe('serializeBackendMessages', () => {
  it('keeps tool pairs and is sent alongside client_tool_results', () => {
    const acc = new TurnToolHistoryAccumulator();
    acc.apply({ type: 'text_delta', content: '先预览。' });
    acc.apply({
      type: 'tool_start',
      toolCallId: 'v1',
      name: 'read_image_for_vision',
      arguments: JSON.stringify({ relative_path: '6.jpg' }),
    });
    acc.apply({
      type: 'tool_result',
      toolCallId: 'v1',
      result: '{"ok":true}',
    });
    const prior = [{ role: 'user', content: '标注第 6~8 张并更新记忆' }];
    const serialized = serializeBackendMessages(
      mergeResumeMessages(prior, acc.snapshot()),
    );
    expect(serialized[0]).toEqual({
      role: 'user',
      content: '标注第 6~8 张并更新记忆',
    });
    expect(serialized[1]).toMatchObject({
      role: 'assistant',
      content: '先预览。',
      tool_calls: [
        {
          id: 'v1',
          name: 'read_image_for_vision',
          args: { relative_path: '6.jpg' },
        },
      ],
    });
    expect(serialized[2]).toEqual({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 'v1',
    });
    const clientToolResults = [
      {
        toolCallId: 'a1',
        name: 'auto_annotate',
        result: '{"status":"completed"}',
      },
    ];
    expect(clientToolResults).toHaveLength(1);
    expect(serialized.some((m) => m.role === 'tool')).toBe(true);
  });
});
