import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import type { TagDeletionReview } from '@/bgsm-agent/tag-deletion-review';
import { bgCall } from '@/utils/messaging';
import { Button } from '@/ui/shadcn/button';

export function AgentTagDeletionReview({ sessionId, active }: { sessionId: string | null; active: boolean }) {
  const { m } = useI18n();
  const [reviews, setReviews] = useState<TagDeletionReview[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReviews([]);
    setError(null);
    if (!active || !sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await bgCall('listAgentTagDeletionReviews', { sessionId });
        if (!cancelled) setReviews(next);
      } catch {
        if (!cancelled) setReviews([]);
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 1_000);
      }
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, sessionId]);

  const decide = async (review: TagDeletionReview, approved: boolean) => {
    setBusy(review.id);
    try {
      const accepted = await bgCall('decideAgentTagDeletion', { sessionId: review.sessionId, id: review.id, approved });
      if (!accepted) throw new Error(m.agentPanel.deletionExpired);
      setReviews((current) => current.filter((item) => item.id !== review.id));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  if (!active || !sessionId) return null;
  return <>{reviews.filter((review) => review.sessionId === sessionId).map((review) => <section key={review.id}
    className="mx-3 my-2 max-h-72 shrink-0 space-y-2 overflow-y-auto rounded-md border border-destructive/40 bg-card p-3 text-xs"
    aria-label={m.agentPanel.deletionTitle} data-testid="agent-tag-deletion-review">
    <h3 className="font-semibold">{m.agentPanel.deletionTitle}</h3>
    <p>{review.proposal.kind === 'global' ? m.agentPanel.deletionGlobal : m.agentPanel.deletionRepositories}</p>
    <ul className="space-y-1 break-words">
      {review.proposal.kind === 'global'
        ? review.proposal.tags.map((tag) => <li key={tag}>{tag}</li>)
        : review.proposal.changes.map((change) => <li key={change.full_name}><strong>{change.full_name}</strong>: {change.tags.join(', ')}</li>)}
    </ul>
    <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decide(review, false)}>{m.common.cancel}</Button>
      <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => void decide(review, true)}>{m.agentPanel.deletionConfirm}</Button>
    </div>
  </section>)}{error && <p role="alert" className="px-3 text-xs text-destructive">{error}</p>}</>;
}
