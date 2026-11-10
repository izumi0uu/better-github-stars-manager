import type { TagDeletionProposal, TagDeletionReview } from '@/bgsm-agent/tag-deletion-review';

/** Approval lives only as long as the waiting turn; worker loss never grants it. */
export function createAgentTagDeletionReviews() {
  const pending = new Map<string, { review: TagDeletionReview; settle(approved: boolean): void }>();
  return {
    request(sessionId: string, proposal: TagDeletionProposal, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false);
      return new Promise((resolve) => {
        const review = { id: crypto.randomUUID(), sessionId, proposal: structuredClone(proposal) };
        const abort = () => settle(false);
        const settle = (approved: boolean) => {
          if (!pending.delete(review.id)) return;
          signal.removeEventListener('abort', abort);
          resolve(approved && !signal.aborted);
        };
        pending.set(review.id, { review, settle });
        signal.addEventListener('abort', abort, { once: true });
      });
    },
    list(sessionId: string): TagDeletionReview[] {
      return [...pending.values()].filter((entry) => entry.review.sessionId === sessionId)
        .map((entry) => structuredClone(entry.review));
    },
    decide(sessionId: string, id: string, approved: boolean): boolean {
      const entry = pending.get(id);
      if (!entry || entry.review.sessionId !== sessionId || typeof approved !== 'boolean') return false;
      entry.settle(approved);
      return true;
    },
  };
}
