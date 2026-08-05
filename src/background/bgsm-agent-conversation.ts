import {
  createBgsmAgentConversationBinding,
  createBgsmAgentConversationScopeFingerprint,
  validateBgsmAgentConversationBinding,
  validateBgsmAgentConversationCandidate,
  type BgsmAgentConversationBinding,
  type BgsmAgentConversationCandidate,
  type BgsmAgentTurnInput,
} from '@/bgsm-agent';
import type { ResolvedLaunchCandidate } from './query';

export type ResolvedBgsmAgentConversation = Readonly<{
  binding: BgsmAgentConversationBinding;
  repositoryIds: readonly string[];
}>;

export async function resolveBgsmAgentConversation(
  input: BgsmAgentTurnInput,
  dependencies: Readonly<{
    providerFingerprint: string;
    resolveCandidate(candidate: BgsmAgentConversationCandidate): Promise<ResolvedLaunchCandidate>;
  }>,
): Promise<ResolvedBgsmAgentConversation> {
  if (input.binding) {
    if (input.candidateContract) {
      throw new TypeError('A bound conversation cannot replace its scope candidate.');
    }
    validateBgsmAgentConversationBinding(input.binding);
    if (input.binding.providerFingerprint !== dependencies.providerFingerprint) {
      throw new TypeError('Cubby provider changed. Start a new conversation.');
    }
    const candidate = await dependencies.resolveCandidate(input.binding.candidateContract);
    const recomputed = await bindingFor(
      input.binding.candidateContract,
      candidate,
      dependencies.providerFingerprint,
    );
    if (
      recomputed.scopeFingerprint !== input.binding.scopeFingerprint
      || recomputed.label !== input.binding.label
      || recomputed.count !== input.binding.count
    ) {
      throw new TypeError('Cubby scope changed. Start a new conversation.');
    }
    return Object.freeze({
      binding: input.binding,
      repositoryIds: Object.freeze([...candidate.repositoryIds]),
    });
  }

  if (!input.candidateContract) {
    throw new TypeError('A new Cubby conversation requires a scope candidate.');
  }
  if (input.baseRevision !== 0 || input.history.length !== 0 || input.checkpoint) {
    throw new TypeError('Only an empty first turn may create a conversation binding.');
  }
  validateBgsmAgentConversationCandidate(input.candidateContract);
  const candidate = await dependencies.resolveCandidate(input.candidateContract);
  const binding = await bindingFor(
    input.candidateContract,
    candidate,
    dependencies.providerFingerprint,
  );
  return Object.freeze({
    binding,
    repositoryIds: Object.freeze([...candidate.repositoryIds]),
  });
}

async function bindingFor(
  candidateContract: BgsmAgentConversationCandidate,
  candidate: ResolvedLaunchCandidate,
  providerFingerprint: string,
): Promise<BgsmAgentConversationBinding> {
  validateBgsmAgentConversationCandidate(candidate.contract);
  if (candidate.repositoryIds.length === 0) {
    throw new TypeError('Cubby conversation scope is empty.');
  }
  const scopeFingerprint = await createBgsmAgentConversationScopeFingerprint({
    candidateContract,
    repositoryIds: candidate.repositoryIds,
    label: candidate.label,
  });
  return createBgsmAgentConversationBinding({
    candidateContract,
    scopeFingerprint,
    label: candidate.label,
    count: candidate.repositoryIds.length,
    providerFingerprint,
  });
}
