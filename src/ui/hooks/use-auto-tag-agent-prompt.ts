import { useCallback, useEffect, useRef, useState } from 'react';
import { authStore } from '@/auth/auth-store';

export function useAutoTagAgentPrompt({
  onOpenAgent,
  onRunAutoTags,
}: {
  onOpenAgent: () => void;
  onRunAutoTags: () => void;
}) {
  const [open, setOpen] = useState(false);
  const seenRef = useRef<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void authStore.getConfig()
      .then((config) => {
        if (active) seenRef.current = config.autoTagAgentPromptSeen;
      })
      .catch(() => {
        if (active) seenRef.current = false;
      });
    return () => {
      active = false;
    };
  }, []);

  const requestAutoTags = useCallback(async () => {
    let seen = seenRef.current;
    if (seen === null) {
      try {
        seen = (await authStore.getConfig()).autoTagAgentPromptSeen;
      } catch {
        seen = false;
      }
      seenRef.current = seen;
    }
    if (seen) {
      onRunAutoTags();
      return;
    }
    setOpen(true);
  }, [onRunAutoTags]);

  const rememberChoice = useCallback(() => {
    seenRef.current = true;
    setOpen(false);
    void authStore.update({ autoTagAgentPromptSeen: true }).catch(() => {});
  }, []);

  const chooseAgent = useCallback(() => {
    rememberChoice();
    onOpenAgent();
  }, [onOpenAgent, rememberChoice]);

  const chooseAutoTags = useCallback(() => {
    rememberChoice();
    onRunAutoTags();
  }, [onRunAutoTags, rememberChoice]);

  const dismiss = useCallback(() => setOpen(false), []);

  return {
    open,
    requestAutoTags,
    chooseAgent,
    chooseAutoTags,
    dismiss,
  };
}
