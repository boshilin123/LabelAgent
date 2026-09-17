import type { AgentSession } from '../../shared/agentTypes';

export function shouldClearSummaryOnEdit(
  session: AgentSession,
  messageIds: string[],
  editMessageId: string,
): boolean {
  if (!session.summaryUpToMessageId) return false;
  const summaryIndex = messageIds.indexOf(session.summaryUpToMessageId);
  const editIndex = messageIds.indexOf(editMessageId);
  if (summaryIndex < 0 || editIndex < 0) return true;
  return editIndex <= summaryIndex;
}
