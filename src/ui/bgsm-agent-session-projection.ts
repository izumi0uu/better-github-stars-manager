import type {
  BgsmAgentSession,
  BgsmAgentSessionMessage,
} from '@/bgsm-agent/session';
import type {
  BgsmAgentSessionSummary,
  LoadedAgentSession,
} from '@/storage/agent-session-store';
import { BackgroundCallError } from '@/utils/messaging';

export type BgsmAgentChatMessage = {
  id: string;
  role: 'assistant' | 'user' | 'tool';
  content: string;
  createdAt: number;
  toolName?: string;
  sequence?: number;
  streaming?: boolean;
};

export type AgentSessionCacheRecord = {
  summary: BgsmAgentSessionSummary;
  session: BgsmAgentSession | null;
  messages: BgsmAgentChatMessage[] | null;
  nextBeforeSequence: number | null;
};

export function cacheRecordFromLoaded(loaded: LoadedAgentSession): AgentSessionCacheRecord {
  const session: BgsmAgentSession = {
    ...loaded.session,
    messages: loaded.transcript.messages.map(toCanonicalMessage),
  };
  return {
    summary: loaded.summary,
    session,
    messages: loaded.transcript.messages
      .filter((message) => !isEmptyToolCallEnvelope(message))
      .map(toChatMessage),
    nextBeforeSequence: loaded.transcript.nextBeforeSequence,
  };
}

export function mergeCanonicalMessages(
  earlier: readonly BgsmAgentSessionMessage[],
  later: readonly BgsmAgentSessionMessage[],
): BgsmAgentSessionMessage[] {
  const latestById = new Map<string, BgsmAgentSessionMessage>();
  for (const message of [...earlier, ...later]) latestById.set(message.id, message);
  const seen = new Set<string>();
  return [...earlier, ...later].flatMap((message) => {
    if (seen.has(message.id)) return [];
    seen.add(message.id);
    return [latestById.get(message.id)!];
  });
}

export function mergeChatMessages(
  earlier: readonly BgsmAgentChatMessage[],
  later: readonly BgsmAgentChatMessage[],
): BgsmAgentChatMessage[] {
  const latestById = new Map<string, BgsmAgentChatMessage>();
  const stableOrderById = new Map<string, number>();
  for (const message of [...earlier, ...later]) {
    if (!stableOrderById.has(message.id)) stableOrderById.set(message.id, stableOrderById.size);
    latestById.set(message.id, message);
  }
  const merged = [...latestById.values()];
  if (merged.every((message) => message.sequence !== undefined)) {
    merged.sort((left, right) => (
      left.sequence! - right.sequence!
      || stableOrderById.get(left.id)! - stableOrderById.get(right.id)!
    ));
  }
  return merged;
}

export function mergeCommitPresentation(
  transcript: readonly BgsmAgentChatMessage[],
  presentation: readonly BgsmAgentChatMessage[],
): BgsmAgentChatMessage[] {
  return mergeChatMessages(transcript, presentation);
}

export function classifySessionLoadFailure(
  error: unknown,
): 'corrupt' | 'not_found' | 'transient' {
  if (!(error instanceof BackgroundCallError)) return 'transient';
  if (error.code === 'agent_session_corrupt') return 'corrupt';
  if (error.code === 'agent_session_not_found') return 'not_found';
  return 'transient';
}

export function compareAgentSessionSummaries(
  left: BgsmAgentSessionSummary,
  right: BgsmAgentSessionSummary,
): number {
  return right.updatedAt - left.updatedAt
    || right.createdAt - left.createdAt
    || left.id.localeCompare(right.id);
}

export function toCanonicalMessage(
  message: BgsmAgentSessionMessage & { sequence?: number },
): BgsmAgentSessionMessage {
  const { sequence: _sequence, ...canonical } = message;
  return canonical;
}

export function toChatMessage(
  message: BgsmAgentSessionMessage & { sequence?: number },
): BgsmAgentChatMessage {
  return {
    id: message.id,
    role: message.role === 'agent' ? 'assistant' : message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
  };
}

export function isEmptyToolCallEnvelope(message: BgsmAgentSessionMessage): boolean {
  return message.role === 'agent'
    && message.content.trim().length === 0
    && (message.toolCalls?.length ?? 0) > 0;
}
