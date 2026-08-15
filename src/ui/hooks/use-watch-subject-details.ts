import { useCallback, useEffect, useRef, useState } from 'react';
import { GITHUB_CREDENTIALS_STORAGE_KEY } from '@/auth/auth-store';
import { BackgroundCallError, bgCall } from '@/utils/messaging';
import type {
  GitHubNotificationThread,
  WatchSubjectDetail,
} from '@/watch/watch-model';

export type WatchSubjectDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; detail: WatchSubjectDetail }
  | { status: 'error'; code: string | null; message: string };

function supportedSubject(thread: GitHubNotificationThread): boolean {
  const normalized = thread.subjectType.trim().toLowerCase().replace(/[\s_-]+/gu, '');
  return normalized === 'issue' || normalized === 'pullrequest';
}

export function useWatchSubjectDetails(input: {
  thread: GitHubNotificationThread;
  expanded: boolean;
}) {
  const { thread, expanded } = input;
  const supported = supportedSubject(thread);
  const [state, setState] = useState<WatchSubjectDetailState>({ status: 'idle' });
  const generation = useRef(0);
  const requestedOpen = useRef(false);
  const expandedRef = useRef(expanded);

  expandedRef.current = expanded;

  const load = useCallback(async () => {
    if (!supported) return;
    const requestGeneration = ++generation.current;
    setState({ status: 'loading' });
    try {
      const detail = await bgCall<WatchSubjectDetail>('getWatchSubjectDetail', {
        threadId: thread.id,
      });
      if (generation.current !== requestGeneration) return;
      if (expandedRef.current) setState({ status: 'success', detail });
    } catch (error) {
      if (generation.current !== requestGeneration) return;
      if (expandedRef.current) {
        setState({
          status: 'error',
          code: error instanceof BackgroundCallError ? error.code : null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, [supported, thread.id]);

  useEffect(() => {
    if (!expanded || !supported) {
      requestedOpen.current = false;
      return;
    }
    if (requestedOpen.current) return;
    requestedOpen.current = true;
    void load();
  }, [expanded, load, supported]);

  useEffect(() => {
    const onChanged = globalThis.chrome?.storage?.onChanged;
    if (!onChanged) return;
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !changes[GITHUB_CREDENTIALS_STORAGE_KEY]) return;
      generation.current++;
      requestedOpen.current = true;
      setState(expanded && supported
        ? { status: 'error', code: 'credential_changed', message: 'credential_changed' }
        : { status: 'idle' });
    };
    onChanged.addListener(listener);
    return () => onChanged.removeListener(listener);
  }, [expanded, supported]);

  useEffect(() => () => {
    generation.current++;
  }, []);

  const retry = useCallback(() => {
    requestedOpen.current = true;
    void load();
  }, [load]);

  return { state, supported, retry };
}
