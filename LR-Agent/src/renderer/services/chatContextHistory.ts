import type { ChatMessage } from '../../shared/agentTypes';

interface HistoryPage {
  messages: Record<string, ChatMessage>;
  hasMoreBefore: boolean;
}

/** UI 可以只加载一页；发送前按需补齐尚未摘要的历史，保留内存中最新的消息。 */
export async function loadContextHistory(options: {
  messageIds: string[];
  messages: Record<string, ChatMessage>;
  summaryUpToMessageId?: string;
  loadPage: (beforeMessageId?: string) => Promise<HistoryPage>;
}): Promise<Record<string, ChatMessage>> {
  const cutoff = options.summaryUpToMessageId
    ? options.messageIds.indexOf(options.summaryUpToMessageId)
    : -1;
  const requiredIds = options.messageIds.slice(cutoff + 1);
  const messages = { ...options.messages };
  let before: string | undefined;
  const cursors = new Set<string>();
  while (requiredIds.some((id) => !messages[id])) {
    const page = await options.loadPage(before);
    for (const [id, message] of Object.entries(page.messages)) {
      if (!messages[id]) messages[id] = message;
    }
    if (requiredIds.every((id) => messages[id])) return messages;
    const oldestId = options.messageIds.find((id) => page.messages[id]);
    if (!page.hasMoreBefore || !oldestId || cursors.has(oldestId)) {
      throw new Error(
        '无法完整读取本地会话历史，消息已保留，请重新打开会话后重试。',
      );
    }
    cursors.add(oldestId);
    before = oldestId;
  }
  return messages;
}
