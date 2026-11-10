import { useI18n } from '@/i18n';
import { Button } from '@/ui/shadcn/button';
import type { useBulkUnstar } from '@/ui/hooks/use-bulk-unstar';

export function BulkUnstarToolbar({ batch, disabled }: {
  batch: ReturnType<typeof useBulkUnstar>;
  disabled: boolean;
}) {
  const { m } = useI18n();
  return <div className="border-b border-border bg-card px-3 py-2 text-xs" data-testid="bulk-unstar-toolbar">
    <div className="flex flex-wrap items-center gap-2">
      {!batch.enabled ? <Button size="sm" variant="ghost" disabled={disabled} onClick={batch.start}>{m.manager.batchSelect}</Button> : <>
        <span aria-live="polite">{m.manager.selectedCount(batch.selected.size)}</span>
        <Button size="sm" variant="ghost" disabled={disabled || batch.busy} onClick={batch.selectShown}>{m.manager.selectShown}</Button>
        <Button size="sm" variant="outline" disabled={disabled || batch.busy || !batch.selected.size} onClick={() => batch.setReview([...batch.selected])}>{m.manager.batchUnstar}</Button>
        <Button size="sm" variant="ghost" disabled={batch.busy} onClick={batch.cancel}>{m.common.cancel}</Button>
      </>}
    </div>
    {batch.review && <section className="mt-2 space-y-2 rounded-md border border-border p-3" aria-label={m.manager.batchUnstar}>
      <p>{m.manager.batchUnstarConfirm(batch.review.length)}</p>
      <ul className="max-h-40 overflow-y-auto font-mono">{batch.review.map((name) => <li key={name}>{name}</li>)}</ul>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={disabled || batch.busy} onClick={() => void batch.confirm()}>{batch.busy ? m.common.loading : m.manager.batchUnstar}</Button>
        <Button size="sm" variant="ghost" disabled={batch.busy} onClick={() => batch.setReview(null)}>{m.common.cancel}</Button>
      </div>
    </section>}
    {batch.feedback && <p className="mt-2" role="status">{batch.feedback}</p>}
  </div>;
}
