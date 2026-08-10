import { describe, expect, it } from 'vitest';
import {
  cacheRecordFromLoaded,
  classifySessionLoadFailure,
  compareAgentSessionSummaries,
  isEmptyToolCallEnvelope,
  mergeCanonicalMessages,
  mergeChatMessages,
  mergeCommitPresentation,
  toCanonicalMessage,
  toChatMessage,
} from '@/ui/bgsm-agent-session-projection';
import { BackgroundCallError } from '@/utils/messaging';
import type { BgsmAgentSessionMessage } from '@/bgsm-agent/session';
import type { LoadedAgentSession } from '@/storage/agent-session-store';

function message(
  id: string,
  content: string,
  overrides: Partial<BgsmAgentSessionMessage> = {},
): BgsmAgentSessionMessage {
  return {
    id,
    role: 'agent',
    content,
    createdAt: 1,
    ...overrides,
  };
}

describe('BGSM Agent session projection', () => {
  it('keeps first-seen canonical order while adopting the latest duplicate', () => {
    const earlier = [message('one', 'old'), message('two', 'second')];
    const later = [message('one', 'new'), message('three', 'third')];

    expect(mergeCanonicalMessages(earlier, later).map(({ id, content }) => ({ id, content })))
      .toEqual([
        { id: 'one', content: 'new' },
        { id: 'two', content: 'second' },
        { id: 'three', content: 'third' },
      ]);
  });

  it('orders sequenced chat messages without destabilizing equal sequences', () => {
    const merged = mergeChatMessages([
      { id: 'later-a', role: 'assistant', content: 'A', createdAt: 1, sequence: 2 },
      { id: 'first', role: 'user', content: 'First', createdAt: 1, sequence: 1 },
    ], [
      { id: 'later-b', role: 'assistant', content: 'B', createdAt: 1, sequence: 2 },
    ]);

    expect(merged.map((item) => item.id)).toEqual(['first', 'later-a', 'later-b']);
  });

  it('removes transport-only sequence data and maps agent roles for chat', () => {
    const canonical = message('answer', 'Done', { toolName: 'read_repository' });
    const sequenced = { ...canonical, sequence: 7 };

    expect(toCanonicalMessage(sequenced)).toEqual(canonical);
    expect(toChatMessage(sequenced)).toEqual({
      id: 'answer',
      role: 'assistant',
      content: 'Done',
      createdAt: 1,
      sequence: 7,
      toolName: 'read_repository',
    });
  });

  it('hides empty assistant tool-call envelopes from the product transcript', () => {
    expect(isEmptyToolCallEnvelope(message('tool-call', '', {
      toolCalls: [{ id: 'call-one', name: 'read_repository', arguments: {} }],
    }))).toBe(true);
    expect(isEmptyToolCallEnvelope(message('visible', 'Reading now.', {
      toolCalls: [{ id: 'call-two', name: 'read_repository', arguments: {} }],
    }))).toBe(false);
  });

  it('classifies only durable not-found and corruption codes as terminal load failures', () => {
    expect(classifySessionLoadFailure(
      new BackgroundCallError('missing', undefined, 'agent_session_not_found'),
    )).toBe('not_found');
    expect(classifySessionLoadFailure(
      new BackgroundCallError('bad', undefined, 'agent_session_corrupt'),
    )).toBe('corrupt');
    expect(classifySessionLoadFailure(
      new BackgroundCallError('offline', undefined, 'transport_unavailable'),
    )).toBe('transient');
    expect(classifySessionLoadFailure(new Error('offline'))).toBe('transient');
  });

  it('builds a cache record while keeping transport-only envelopes canonical', () => {
    const visible = { ...message('visible', 'Answer'), sequence: 2 };
    const envelope = {
      ...message('tool-call', '', {
        toolCalls: [{ id: 'call-one', name: 'read_repository', arguments: {} }],
      }),
      sequence: 1,
    };
    const loaded: LoadedAgentSession = {
      session: { id: 'session-one', revision: 2 },
      transcript: {
        sessionId: 'session-one',
        messages: [envelope, visible],
        nextBeforeSequence: 1,
      },
      summary: { id: 'session-one', title: 'One', createdAt: 1, updatedAt: 2 },
      lastAppliedTurnAttemptId: null,
      appliedTurnReceipts: [],
    };

    const record = cacheRecordFromLoaded(loaded);
    expect(record.session?.messages).toEqual([
      toCanonicalMessage(envelope),
      toCanonicalMessage(visible),
    ]);
    expect(record.messages?.map(({ id }) => id)).toEqual(['visible']);
    expect(record.nextBeforeSequence).toBe(1);
  });

  it('uses sequence-aware commit presentation and deterministic summary ordering', () => {
    const merged = mergeCommitPresentation([
      { id: 'two', role: 'assistant', content: 'old', createdAt: 1, sequence: 2 },
    ], [
      { id: 'one', role: 'user', content: 'first', createdAt: 1, sequence: 1 },
      { id: 'two', role: 'assistant', content: 'new', createdAt: 2, sequence: 2 },
    ]);
    expect(merged.map(({ id, content }) => ({ id, content }))).toEqual([
      { id: 'one', content: 'first' },
      { id: 'two', content: 'new' },
    ]);

    const summaries = [
      { id: 'b', title: '', createdAt: 1, updatedAt: 2 },
      { id: 'a', title: '', createdAt: 1, updatedAt: 2 },
      { id: 'newest', title: '', createdAt: 1, updatedAt: 3 },
    ].sort(compareAgentSessionSummaries);
    expect(summaries.map(({ id }) => id)).toEqual(['newest', 'a', 'b']);
  });
});
