import { translateError } from '@/api/errors';
import { useEffect, useRef, useState } from 'react';
import type { Star } from '@/types';
import { MAX_BULK_UNSTAR_REPOSITORIES } from '@/stars/bulk-unstar';
import { useManagerRuntime } from '@/ui/manager-runtime-context';
import { useI18n } from '@/i18n';

export function useBulkUnstar(rows: Star[], accountLogin: string | null) {
  const runtime = useManagerRuntime();
  const { m } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const pending = useRef(false);
  const account = useRef(accountLogin);
  account.current = accountLogin;
  const eligible = rows.filter((star) => !star.tombstone && star.viewer_has_starred !== false);

  useEffect(() => {
    setSelected(new Set());
    setReview(null);
    setEnabled(false);
    setFeedback(null);
  }, [accountLogin]);
  useEffect(() => {
    if (pending.current) return;
    const names = new Set(rows.filter((row) => !row.tombstone && row.viewer_has_starred !== false).map((row) => row.full_name));
    setSelected((current) => {
      const next = new Set([...current].filter((name) => names.has(name)));
      return next.size === current.size ? current : next;
    });
    setReview(null);
  }, [rows]);

  const describeError = (error: unknown) => {
    const code = error instanceof Error ? error.message : String(error);
    if (code === 'GITHUB_CREDENTIAL_CHANGED') return m.manager.batchAccountChanged;
    if (code === 'REPOSITORY_NOT_STARRED') return m.manager.batchRepositoryChanged;
    return translateError(error, m);
  };

  const confirm = async () => {
    if (!review?.length || !accountLogin || pending.current) return;
    const owner = accountLogin;
    const fullNames = [...review];
    pending.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await runtime.bulkUnstar({ accountLogin: owner, fullNames });
      if (account.current !== owner) return;
      const remaining = [...result.failed.map((failure) => failure.fullName), ...result.notAttempted];
      setSelected(new Set(remaining));
      setFeedback(m.manager.batchUnstarResult(result.succeeded.length, remaining.length)
        + (result.failed[0] ? ` ${result.failed[0].fullName}: ${describeError(result.failed[0].error)}` : ''));
      setReview(null);
    } catch (error) {
      if (account.current === owner) setFeedback(describeError(error));
      setReview(null);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return {
    enabled, selected, review, busy, feedback, setReview, confirm,
    start: () => { setEnabled(true); setFeedback(null); },
    cancel: () => { if (!pending.current) { setEnabled(false); setSelected(new Set()); setReview(null); } },
    selectShown: () => setSelected(new Set(eligible.slice(0, MAX_BULK_UNSTAR_REPOSITORIES).map((row) => row.full_name))),
    toggle: (fullName: string) => {
      if (pending.current) return;
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(fullName)) next.delete(fullName);
        else if (next.size < MAX_BULK_UNSTAR_REPOSITORIES) next.add(fullName);
        return next;
      });
      setReview(null);
    },
  };
}
