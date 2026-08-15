import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import type { Star, Tag } from '@/types';
import { bgCall } from '@/utils/messaging';
import { pruneFavoriteOverrides, type FavoriteOverrideState } from '@/ui/favorite-state';
import { nextOpenUnstarFullName } from '@/ui/unstar-popover-state';

export type UnstarFeedback =
  | { kind: 'done'; fullName: string }
  | { kind: 'failed'; fullName: string; error: string };

type UseManagerStarActionsOptions = {
  rows: Star[];
  tagsByFullName: Map<string, Tag>;
  info: string | null;
  interactionLocked: boolean;
  setInfo: (info: string | null) => void;
  onMeaningfulAction: () => void;
  onUnstarred: (fullName: string) => void;
};

export function useManagerStarActions({
  rows,
  tagsByFullName,
  info,
  interactionLocked,
  setInfo,
  onMeaningfulAction,
  onUnstarred,
}: UseManagerStarActionsOptions) {
  const { m } = useI18n();
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<string, FavoriteOverrideState>>({});
  const [unstarFeedback, setUnstarFeedback] = useState<UnstarFeedback | null>(null);
  const [openUnstarFullName, setOpenUnstarFullName] = useState<string | null>(null);

  useEffect(() => {
    const currentNames = new Set(rows.map((row) => row.full_name));
    setFavoriteOverrides((current) => pruneFavoriteOverrides(current, tagsByFullName, rows));
    setOpenUnstarFullName((current) => (current && !currentNames.has(current) ? null : current));
  }, [rows, tagsByFullName]);

  useEffect(() => {
    if (info) setUnstarFeedback(null);
  }, [info]);

  const toggleFavorite = useCallback(async (fullName: string, favorite: boolean) => {
    setFavoriteOverrides((current) => ({
      ...current,
      [fullName]: { value: favorite, pending: true },
    }));
    try {
      await bgCall('setFavorite', { full_name: fullName, favorite });
      setFavoriteOverrides((current) => ({
        ...current,
        [fullName]: { value: favorite, pending: false },
      }));
      setUnstarFeedback(null);
      setInfo(null);
      onMeaningfulAction();
    } catch (error) {
      setFavoriteOverrides((current) => {
        if (!(fullName in current)) return current;
        const next = { ...current };
        delete next[fullName];
        return next;
      });
      setUnstarFeedback(null);
      setInfo(m.manager.syncFailed(
        m.toolbar.columnFavorite,
        error instanceof Error ? error.message : String(error),
      ));
      throw error;
    }
  }, [m, onMeaningfulAction, setInfo]);

  const confirmUnstar = useCallback((fullName: string) => {
    if (interactionLocked) return;

    setOpenUnstarFullName(null);
    setUnstarFeedback(null);
    setInfo(null);

    bgCall('markUnstarred', { full_name: fullName })
      .then(() => {
        onUnstarred(fullName);
        setUnstarFeedback({ kind: 'done', fullName });
      })
      .catch((error) => {
        setUnstarFeedback({
          kind: 'failed',
          fullName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [interactionLocked, onUnstarred, setInfo]);

  const changeUnstarPopover = useCallback((open: boolean, sourceFullName: string) => {
    setOpenUnstarFullName((current) => nextOpenUnstarFullName(
      current,
      open ? sourceFullName : null,
      sourceFullName,
    ));
  }, []);

  const closeUnstarPopover = useCallback(() => {
    setOpenUnstarFullName(null);
  }, []);

  const clearUnstarFeedback = useCallback(() => {
    setUnstarFeedback(null);
  }, []);

  const resetUnstarPresentation = useCallback(() => {
    setOpenUnstarFullName(null);
    setUnstarFeedback(null);
  }, []);

  return {
    favoriteOverrides,
    unstarFeedback,
    openUnstarFullName,
    toggleFavorite,
    confirmUnstar,
    changeUnstarPopover,
    closeUnstarPopover,
    clearUnstarFeedback,
    resetUnstarPresentation,
  };
}
