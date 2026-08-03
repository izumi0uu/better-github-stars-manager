import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createBgsmAgentConversationBinding,
  createBgsmAgentConversationScopeFingerprint,
  type BgsmAgentConversationCandidate,
  type BgsmAgentTurnInput,
} from '@/bgsm-agent';
import { resolveBgsmAgentConversation } from '@/background/bgsm-agent-conversation';

const PROVIDER = `pcf:v1:${'a'.repeat(43)}`;
const OTHER_PROVIDER = `pcf:v1:${'b'.repeat(43)}`;
const candidate: BgsmAgentConversationCandidate = {
  kind: 'selected_repository',
  selectedRepositoryIdHint: 'owner/repo',
};

function firstTurn(overrides: Partial<BgsmAgentTurnInput> = {}): BgsmAgentTurnInput {
  return {
    turnAttemptId: 'turn-attempt-1',
    sessionId: 'session-1',
    baseRevision: 0,
    prompt: 'Search this repository',
    history: [],
    candidateContract: candidate,
    ...overrides,
  };
}

function resolver(repositoryIds = ['owner/repo']) {
  return async (contract: BgsmAgentConversationCandidate) => ({
    contract,
    repositoryIds,
    label: contract.kind === 'selected_repository' ? contract.selectedRepositoryIdHint : 'Current view',
    filterSnapshot: 'unused by conversation binding',
  });
}

describe('Cubby conversation scope binding', () => {
  it('creates a deterministic first-turn scope/provider binding', async () => {
    const first = await resolveBgsmAgentConversation(firstTurn(), {
      providerFingerprint: PROVIDER,
      resolveCandidate: resolver(),
    });
    const second = await resolveBgsmAgentConversation(firstTurn(), {
      providerFingerprint: PROVIDER,
      resolveCandidate: resolver(),
    });

    assert.deepEqual(first, second);
    assert.equal(first.binding.count, 1);
    assert.equal(first.binding.candidateContract, candidate);
    assert.deepEqual(first.repositoryIds, ['owner/repo']);
  });

  it('rejects nonempty history, missing candidates, empty scopes, and unsupported scope kinds', async () => {
    await assert.rejects(
      resolveBgsmAgentConversation(firstTurn({
        history: [{ id: 'old', role: 'user', content: 'old', createdAt: 1 }],
      }), { providerFingerprint: PROVIDER, resolveCandidate: resolver() }),
      /empty first turn/i,
    );
    await assert.rejects(
      resolveBgsmAgentConversation(firstTurn({ candidateContract: undefined }), {
        providerFingerprint: PROVIDER,
        resolveCandidate: resolver(),
      }),
      /requires a scope candidate/i,
    );
    await assert.rejects(
      resolveBgsmAgentConversation(firstTurn(), {
        providerFingerprint: PROVIDER,
        resolveCandidate: resolver([]),
      }),
      /scope is empty/i,
    );
    await assert.rejects(
      resolveBgsmAgentConversation(firstTurn({
        candidateContract: { kind: 'all_live_stars' } as never,
      }), { providerFingerprint: PROVIDER, resolveCandidate: resolver() }),
      /selected repository or current view/i,
    );
  });

  it('recomputes later scopes and rejects candidate or Provider drift', async () => {
    const scopeFingerprint = await createBgsmAgentConversationScopeFingerprint({
      candidateContract: candidate,
      repositoryIds: ['owner/repo'],
      label: 'owner/repo',
    });
    const binding = createBgsmAgentConversationBinding({
      candidateContract: candidate,
      scopeFingerprint,
      label: 'owner/repo',
      count: 1,
      providerFingerprint: PROVIDER,
    });
    const later: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-later',
      sessionId: 'session-1',
      baseRevision: 1,
      prompt: 'Follow up',
      history: [{ id: 'old', role: 'user', content: 'old', createdAt: 1 }],
      binding,
    };

    const resolved = await resolveBgsmAgentConversation(later, {
      providerFingerprint: PROVIDER,
      resolveCandidate: resolver(),
    });
    assert.equal(resolved.binding, binding);
    await assert.rejects(
      resolveBgsmAgentConversation(later, {
        providerFingerprint: PROVIDER,
        resolveCandidate: resolver(['owner/repo', 'owner/other']),
      }),
      /scope changed/i,
    );
    await assert.rejects(
      resolveBgsmAgentConversation(later, {
        providerFingerprint: OTHER_PROVIDER,
        resolveCandidate: resolver(),
      }),
      /provider changed/i,
    );
    await assert.rejects(
      resolveBgsmAgentConversation({ ...later, candidateContract: candidate }, {
        providerFingerprint: PROVIDER,
        resolveCandidate: resolver(),
      }),
      /cannot replace/i,
    );
  });
});
