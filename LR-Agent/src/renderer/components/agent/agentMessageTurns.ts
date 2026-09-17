export type TurnMessage = {
  id: string;
  role: string;
};

export type MessageTurn<T extends TurnMessage> = {
  key: string;
  messages: T[];
};

/** 每一轮 = 一条用户消息 + 其后的助手/系统回复。Sticky 必须限制在这一层里，否则多轮会叠在 top:0。 */
export function groupMessagesIntoTurns<T extends TurnMessage>(
  messages: T[],
): MessageTurn<T>[] {
  const turns: MessageTurn<T>[] = [];
  for (const message of messages) {
    if (message.role === 'user' || turns.length === 0) {
      turns.push({ key: message.id, messages: [message] });
      continue;
    }
    turns[turns.length - 1].messages.push(message);
  }
  return turns;
}
