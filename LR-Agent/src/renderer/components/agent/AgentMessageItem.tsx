import type { ChatMessage } from '../../types/agent';
import AgentAssistantMessage from './AgentAssistantMessage';
import AgentUserMessage from './AgentUserMessage';
import './AgentMessageItem.css';

interface AgentMessageItemProps {
  message: ChatMessage;
}

export default function AgentMessageItem({ message }: AgentMessageItemProps) {
  if (message.role === 'user') {
    return <AgentUserMessage message={message} />;
  }
  if (message.role === 'assistant') {
    return <AgentAssistantMessage message={message} />;
  }
  return null;
}
