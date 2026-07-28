import type { AgentMessage } from '../messages';

export type CompleteTurn = {
  start: number;
  end: number;
};

export type CompactionCheckpointCursor = {
  summarizedMessageCount: number;
  summarizedThroughMessageId: string;
};

export type ParsedCommittedHistory = {
  turns: CompleteTurn[];
  legalBoundaries: number[];
};

export class InvalidCommittedHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCommittedHistoryError';
  }
}

export function parseCommittedHistory(
  history: readonly AgentMessage[],
): ParsedCommittedHistory {
  const turns: CompleteTurn[] = [];
  let index = 0;

  while (index < history.length) {
    const turnStart = index;
    assertRole(history[index], 'user', index, 'A committed turn must begin with a user message.');
    index += 1;

    while (true) {
      const assistant = history[index];
      assertRole(
        assistant,
        'agent',
        index,
        'A user message must be followed by an assistant message.',
      );
      const toolCalls = assistant.toolCalls ?? [];
      if (toolCalls.length === 0) {
        index += 1;
        turns.push({ start: turnStart, end: index });
        break;
      }

      const declaredIds = new Set<string>();
      for (const [callIndex, toolCall] of toolCalls.entries()) {
        if (!toolCall.id || !toolCall.name || declaredIds.has(toolCall.id)) {
          throw invalid(index, 'Tool-call IDs and names must be non-empty and unique.');
        }
        declaredIds.add(toolCall.id);

        const resultIndex = index + callIndex + 1;
        const result = history[resultIndex];
        assertRole(
          result,
          'tool',
          resultIndex,
          'Every declared tool call must have exactly one following result.',
        );
        if (result.toolCallId !== toolCall.id || result.toolName !== toolCall.name) {
          throw invalid(
            resultIndex,
            'Tool results must match declared call IDs and tool names in declaration order.',
          );
        }
        if ((result.toolCalls?.length ?? 0) > 0) {
          throw invalid(resultIndex, 'Tool-result messages cannot declare tool calls.');
        }
      }
      index += toolCalls.length + 1;
      if (index === history.length || history[index]?.role === 'user') {
        turns.push({ start: turnStart, end: index });
        break;
      }
    }
  }

  return {
    turns,
    legalBoundaries: turns.map((turn) => turn.end),
  };
}

export function verifyCheckpointCursor(
  history: readonly AgentMessage[],
  cursor: CompactionCheckpointCursor,
  parsed = parseCommittedHistory(history),
): number {
  const count = cursor.summarizedMessageCount;
  if (!Number.isSafeInteger(count) || count <= 0 || count > history.length) {
    throw new InvalidCommittedHistoryError('Checkpoint message count is out of range.');
  }
  if (!parsed.legalBoundaries.includes(count)) {
    throw new InvalidCommittedHistoryError(
      'Checkpoint message count is not a complete-turn boundary.',
    );
  }
  if (history[count - 1]?.id !== cursor.summarizedThroughMessageId) {
    throw new InvalidCommittedHistoryError(
      'Checkpoint terminal message ID does not match committed history.',
    );
  }
  return count;
}

function assertRole(
  message: AgentMessage | undefined,
  role: AgentMessage['role'],
  index: number,
  detail: string,
): asserts message is AgentMessage {
  if (!message || message.role !== role) throw invalid(index, detail);
}

function invalid(index: number, detail: string): InvalidCommittedHistoryError {
  return new InvalidCommittedHistoryError(`Invalid committed history at index ${index}: ${detail}`);
}
