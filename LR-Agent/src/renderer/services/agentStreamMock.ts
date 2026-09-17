import type { StreamEvent } from '../../shared/agentTypes';

const MOCK_REASONING = '让我先理解你的问题，整理关键约束，再给出可执行的回答。';

const MOCK_TOOL_ARGS = JSON.stringify(
  { path: 'src/renderer/components/AgentPanel.tsx' },
  null,
  2,
);

const MOCK_TOOL_RESULT = '已读取 AgentPanel.tsx，当前为占位组件。';

const MOCK_ANSWER = `## 回答

这是一个 **Markdown** 示例，支持：

- 列表与 \`行内代码\`
- 数学公式：行内 $E=mc^2$，块级：

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

> 当前为前端 Mock 流式输出；配置 API Key 后将尝试直连 OpenAI 兼容接口。`;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function* emitCharDeltas(
  text: string,
  type: 'text_delta' | 'reasoning_delta',
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const chunkSize = type === 'reasoning_delta' ? 3 : 2;
  for (let i = 0; i < text.length; i += chunkSize) {
    await sleep(28, signal);
    yield { type, content: text.slice(i, i + chunkSize) };
  }
}

function buildMockAnswer(userContent: string): string {
  const preview = userContent.trim().slice(0, 80);
  return `## 回复

收到你的消息${preview ? `：「${preview}${userContent.length > 80 ? '…' : ''}」` : ''}。

这是 **Markdown** 演示，支持：

- 列表与 \`行内代码\`
- 数学公式：行内 $E=mc^2$，块级：

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

> 当前为 Mock 流式输出。请登录并在「大模型配置」中添加 API Key 后使用真实模型。`;
}

/** 纯文本闲聊 Mock（无工具/推理块） */
export async function* mockChatStream(
  userContent: string,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  try {
    yield* emitCharDeltas(buildMockAnswer(userContent), 'text_delta', signal);
    yield { type: 'done' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : 'Mock 流式输出失败',
    };
  }
}

export async function* mockStreamResponse(
  userContent: string,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  void userContent;
  try {
    yield* emitCharDeltas(MOCK_REASONING, 'reasoning_delta', signal);
    await sleep(400, signal);

    const toolId = `tool-${Date.now()}`;
    yield {
      type: 'tool_start',
      toolCallId: toolId,
      name: 'read_file',
      arguments: MOCK_TOOL_ARGS,
    };
    await sleep(700, signal);
    yield { type: 'tool_result', toolCallId: toolId, result: MOCK_TOOL_RESULT };
    await sleep(300, signal);

    yield* emitCharDeltas(MOCK_ANSWER, 'text_delta', signal);
    yield { type: 'done' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : 'Mock 流式输出失败',
    };
  }
}
