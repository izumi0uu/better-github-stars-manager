import type { ModelToolCall } from './provider';

export type AgentRole = 'user' | 'agent' | 'tool' | 'system';

export type AgentMessage = {
  id: string;
  role: AgentRole;
  content: string;
  createdAt: number;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ModelToolCall[];
};

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ModelToolCall[];
};

export function toModelMessage(message: AgentMessage): ModelMessage {
  const role = message.role === 'agent' ? 'assistant' : message.role;
  return {
    role,
    content: message.content,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    toolCalls: message.toolCalls,
  };
}
