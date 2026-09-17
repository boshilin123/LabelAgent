/** prepare_turn / annotation-run 使用的 user_message_id，须与本轮 UI 用户消息 id 一致。 */
export function resolveUserMessageIdForJob(options: {
  editMessageId: string | null;
  newUserMessageId: string | null;
}): string {
  if (options.editMessageId) {
    return options.editMessageId;
  }
  if (options.newUserMessageId) {
    return options.newUserMessageId;
  }
  throw new Error('resolveUserMessageIdForJob: missing user message id');
}
