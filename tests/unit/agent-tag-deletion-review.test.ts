import { describe, expect, it, vi } from 'vitest';
import { createAgentTagDeletionReviews } from '@/background/agent-tag-deletion-review';
import { createBgsmTurnAuthorization } from '@/bgsm-agent/authorization';
import type { AgentTool } from '@/agent-harness';

const deletion: AgentTool = { name: 'delete_tags_everywhere', risk: 'write', description: '', execute: async () => {} };
const context = { sessionId: 'session', toolCall: { id: 'call', name: deletion.name, arguments: { tags: ['legacy'] } } };

async function authorize(confirmTagDeletion?: NonNullable<Parameters<typeof createBgsmTurnAuthorization>[0]>['confirmTagDeletion']) {
  const auth = createBgsmTurnAuthorization({ confirmTagDeletion });
  const [read] = auth.wrapTools([{ name: 'list_tags', risk: 'read', description: '', execute: async () => ({ tags: [{ name: 'legacy' }] }) }]);
  await read.execute({}, { sessionId: 'session', callId: 'read' });
  return auth;
}

describe('tag deletion review', () => {
  it('denies deletion with valid read evidence when no user approval exists', async () => {
    const auth = await authorize();
    expect(await auth.permissions(deletion, { tags: ['legacy'] }, context)).toMatchObject({ type: 'deny' });
  });

  it('waits for the exact session review and consumes approval once', async () => {
    const reviews = createAgentTagDeletionReviews();
    const controller = new AbortController();
    const auth = await authorize((proposal) => reviews.request('session', proposal, controller.signal));
    const settled = vi.fn();
    const decision = Promise.resolve(auth.permissions(deletion, { tags: ['legacy'] }, context)).then((value) => { settled(); return value; });
    const [review] = reviews.list('session');
    expect(review.proposal).toEqual({ kind: 'global', tags: ['legacy'] });
    expect(reviews.list('other')).toEqual([]);
    expect(reviews.decide('other', review.id, true)).toBe(false);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(reviews.decide('session', review.id, true)).toBe(true);
    expect(await decision).toEqual({ type: 'allow' });
    expect(reviews.decide('session', review.id, true)).toBe(false);
  });

  it.each(['reject', 'abort'] as const)('does not authorize on %s', async (action) => {
    const reviews = createAgentTagDeletionReviews();
    const controller = new AbortController();
    const auth = await authorize((proposal) => reviews.request('session', proposal, controller.signal));
    const decision = auth.permissions(deletion, { tags: ['legacy'] }, context);
    const [review] = reviews.list('session');
    if (action === 'abort') controller.abort();
    else reviews.decide('session', review.id, false);
    expect(await decision).toMatchObject({ type: 'deny' });
    expect(reviews.list('session')).toEqual([]);
    expect(reviews.decide('session', review.id, true)).toBe(false);
  });

  it('does not reuse pending approval after worker replacement', async () => {
    const previous = createAgentTagDeletionReviews();
    const controller = new AbortController();
    const result = previous.request('session', { kind: 'global', tags: ['legacy'] }, controller.signal);
    const [review] = previous.list('session');
    expect(createAgentTagDeletionReviews().decide('session', review.id, true)).toBe(false);
    controller.abort();
    expect(await result).toBe(false);
  });
});
