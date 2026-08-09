import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { BgsmAgentSession } from '@/bgsm-agent/session';
import { AgentCanonicalSessionCache } from '@/storage/agent-session-cache';

function makeSession(id: string, revision: number): BgsmAgentSession {
  const userMessageId = `${id}-user-${revision}`;
  const assistantMessageId = `${id}-assistant-${revision}`;
  const toolCallId = `${id}-call-${revision}`;
  const toolMessageId = `${id}-tool-${revision}`;
  return {
    id,
    revision,
    messages: [
      { id: userMessageId, role: 'user', content: 'Inspect the session.', createdAt: 1 },
      {
        id: assistantMessageId,
        role: 'agent',
        content: '',
        createdAt: 2,
        toolCalls: [{ id: toolCallId, name: 'inspect_session', arguments: { page: 1 } }],
      },
      {
        id: toolMessageId,
        role: 'tool',
        content: '{"ok":true}',
        createdAt: 3,
        toolCallId,
        toolName: 'inspect_session',
      },
    ],
    compaction: {
      schemaVersion: 1,
      summary: 'The session was inspected.',
      summarizedMessageCount: 3,
      summarizedThroughMessageId: toolMessageId,
    },
  };
}

describe('AgentCanonicalSessionCache', () => {
  it('requires an exact session ID and revision for a hit', () => {
    const cache = new AgentCanonicalSessionCache();
    const session = makeSession('session-a', 3);

    cache.put(session);

    const hit = cache.get('session-a', 3);
    assert.ok(hit);
    assert.deepEqual(hit, session);
    assert.notEqual(hit, session);
    assert.equal(cache.get('session-a', 2), null);
    assert.equal(cache.get('session-b', 3), null);
  });

  it('keeps only the latest canonical revision for a session', () => {
    const cache = new AgentCanonicalSessionCache();
    const revisionOne = makeSession('session-a', 1);
    const revisionTwo = makeSession('session-a', 2);

    cache.put(revisionOne);
    cache.put(revisionTwo);
    cache.put(revisionOne);

    assert.equal(cache.get('session-a', 1), null);
    assert.deepEqual(cache.get('session-a', 2), revisionTwo);
  });

  it('evicts the least recently used session after eight entries', () => {
    const cache = new AgentCanonicalSessionCache();
    for (let index = 0; index < 8; index += 1) {
      cache.put(makeSession(`session-${index}`, 1));
    }

    assert.ok(cache.get('session-0', 1));
    cache.put(makeSession('session-8', 1));

    assert.equal(cache.get('session-1', 1), null);
    assert.ok(cache.get('session-0', 1));
    assert.ok(cache.get('session-8', 1));
  });

  it('deletes individual sessions and clears the worker-local cache', () => {
    const cache = new AgentCanonicalSessionCache();
    cache.put(makeSession('session-a', 1));
    cache.put(makeSession('session-b', 1));

    cache.delete('session-a');
    assert.equal(cache.get('session-a', 1), null);
    assert.ok(cache.get('session-b', 1));

    cache.clear();
    assert.equal(cache.get('session-b', 1), null);
  });

  it('isolates cache-owned snapshots from input and returned caller mutation', () => {
    const cache = new AgentCanonicalSessionCache();
    const session = makeSession('session-a', 1);
    cache.put(session);

    session.messages[0]!.content = 'Mutated input.';
    session.messages[1]!.toolCalls![0]!.arguments = { page: 2 };
    session.compaction!.summary = 'Mutated checkpoint.';

    const firstHit = cache.get('session-a', 1);
    assert.ok(firstHit);
    assert.equal(firstHit.messages[0]!.content, 'Inspect the session.');
    assert.deepEqual(firstHit.messages[1]!.toolCalls![0]!.arguments, { page: 1 });
    assert.equal(firstHit.compaction!.summary, 'The session was inspected.');

    firstHit.messages[0]!.content = 'Mutated result.';
    firstHit.messages[1]!.toolCalls![0]!.arguments = { page: 3 };
    firstHit.compaction!.summary = 'Mutated returned checkpoint.';

    const secondHit = cache.get('session-a', 1);
    assert.ok(secondHit);
    assert.equal(secondHit.messages[0]!.content, 'Inspect the session.');
    assert.deepEqual(secondHit.messages[1]!.toolCalls![0]!.arguments, { page: 1 });
    assert.equal(secondHit.compaction!.summary, 'The session was inspected.');
  });
});
