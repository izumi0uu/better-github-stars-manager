import { useCallback, useEffect, useRef, useState } from 'react';
import { authStore, CONFIG_STORAGE_KEY } from '@/auth/auth-store';
import { bgCall } from '@/utils/messaging';
import {
  CURRENT_EXTENSION_STORE_LISTING,
  evaluateStoreRatingPromptEligibility,
  normalizeStoreRatingPromptState,
  type ExtensionStoreListing,
} from '@/store-rating';
import type { Config, StoreRatingPromptState } from '@/types';

const systemNow = () => Date.now();
const STORE_RATING_STATUS_RECHECK_MS = 1_000;

export function useStoreRatingPrompt({
  onboardingComplete,
  onMainManager,
  managerIdle,
  listing = CURRENT_EXTENSION_STORE_LISTING,
  now = systemNow,
}: {
  onboardingComplete: boolean;
  onMainManager: boolean;
  managerIdle: boolean;
  listing?: ExtensionStoreListing | null;
  now?: () => number;
}) {
  const [state, setState] = useState<StoreRatingPromptState | null>(null);
  const [open, setOpen] = useState(false);
  const [qualifyingActionReady, setQualifyingActionReady] = useState(false);
  const [claimedExposureReady, setClaimedExposureReady] = useState(false);
  const exposureClaimInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const terminalDecisionGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void authStore.getConfig()
      .then((config) => {
        if (!cancelled) setState(config.storeRatingPrompt);
      })
      .catch(() => {
        if (!cancelled) setState(normalizeStoreRatingPromptState(null));
      });

    const onChanged = typeof chrome === 'undefined' ? null : chrome.storage?.onChanged;
    if (!onChanged) {
      return () => {
        cancelled = true;
      };
    }
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      const change = changes[CONFIG_STORAGE_KEY];
      if (!change) return;
      const config = change.newValue as Partial<Config> | undefined;
      const nextState = normalizeStoreRatingPromptState(config?.storeRatingPrompt);
      setState(nextState);
      if (nextState.status === 'disabled' || nextState.status === 'store_opened') {
        terminalDecisionGenerationRef.current += 1;
        setOpen(false);
        setQualifyingActionReady(false);
        setClaimedExposureReady(false);
      }
    };
    onChanged.addListener(listener);
    return () => {
      cancelled = true;
      onChanged.removeListener(listener);
    };
  }, []);

  useEffect(() => {
    if (!listing || !onboardingComplete || !onMainManager) return;
    let cancelled = false;
    const recordActiveDay = () => {
      void authStore.recordStoreRatingActiveDay(now())
        .then((config) => {
          if (!cancelled) setState(config.storeRatingPrompt);
        })
        .catch(() => {});
    };
    recordActiveDay();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') recordActiveDay();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [listing, now, onboardingComplete, onMainManager]);

  const recordMeaningfulAction = useCallback(async () => {
    if (!listing || !onboardingComplete) return;
    const terminalDecisionGeneration = terminalDecisionGenerationRef.current;
    try {
      const config = await authStore.recordStoreRatingMeaningfulAction();
      if (!mountedRef.current) return;
      setState(config.storeRatingPrompt);
      if (
        terminalDecisionGeneration !== terminalDecisionGenerationRef.current
        || config.storeRatingPrompt.status === 'disabled'
        || config.storeRatingPrompt.status === 'store_opened'
      ) {
        setQualifyingActionReady(false);
        return;
      }
      setQualifyingActionReady(true);
    } catch {
      // Rating bookkeeping must never turn a successful product action into a failure.
    }
  }, [listing, onboardingComplete]);

  useEffect(() => {
    if (!state || open) return;
    const locallyReady = !!listing
      && onboardingComplete
      && onMainManager
      && managerIdle;
    if (claimedExposureReady) {
      if (!locallyReady) return;
    } else {
      const eligibility = evaluateStoreRatingPromptEligibility({
        state,
        listing,
        now: now(),
        onboardingComplete,
        onMainManager,
        qualifyingActionReady,
        managerIdle,
      });
      if (eligibility !== 'eligible') return;
    }

    let cancelled = false;
    let retryTimer: number | undefined;
    const terminalDecisionGeneration = terminalDecisionGenerationRef.current;
    const checkAuthoritativeStatus = () => {
      void bgCall('getStatus')
        .then((latest) => {
          if (
            cancelled
            || !mountedRef.current
            || terminalDecisionGeneration !== terminalDecisionGenerationRef.current
          ) return;
          if (!latest.hasToken || latest.onboardingStage !== 'done') return;

          const backgroundWorkActive = latest.progress.phase !== 'idle'
            || latest.inFlight
            || !!latest.activeBackfillId
            || latest.organizeJobActive;
          if (backgroundWorkActive) {
            retryTimer = window.setTimeout(() => {
              retryTimer = undefined;
              checkAuthoritativeStatus();
            }, STORE_RATING_STATUS_RECHECK_MS);
            return;
          }

          if (claimedExposureReady) {
            setClaimedExposureReady(false);
            setOpen(true);
            return;
          }
          if (exposureClaimInFlightRef.current) return;
          exposureClaimInFlightRef.current = true;
          const claimAt = now();
          void authStore.consumeStoreRatingPromptExposure(claimAt)
            .then((result) => {
              if (
                !mountedRef.current
                || terminalDecisionGeneration !== terminalDecisionGenerationRef.current
              ) return;
              setState(result.config.storeRatingPrompt);
              if (!result.consumed) return;
              setQualifyingActionReady(false);
              // A storage update can cancel this effect after the durable claim succeeds.
              // Keep the claim armed and recheck both local and background idleness before opening.
              setClaimedExposureReady(true);
            })
            .catch(() => {})
            .finally(() => {
              exposureClaimInFlightRef.current = false;
            });
        })
        .catch(() => {});
    };

    checkAuthoritativeStatus();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, [
    claimedExposureReady,
    listing,
    managerIdle,
    now,
    onMainManager,
    onboardingComplete,
    open,
    qualifyingActionReady,
    state,
  ]);

  const later = useCallback(() => {
    setOpen(false);
    setQualifyingActionReady(false);
    setClaimedExposureReady(false);
    void authStore.snoozeStoreRatingPrompt(now())
      .then((config) => {
        if (mountedRef.current) setState(config.storeRatingPrompt);
      })
      .catch(() => {});
  }, [now]);

  const never = useCallback(() => {
    setOpen(false);
    setQualifyingActionReady(false);
    setClaimedExposureReady(false);
    void authStore.disableStoreRatingPrompt()
      .then((config) => {
        if (mountedRef.current) setState(config.storeRatingPrompt);
      })
      .catch(() => {});
  }, []);

  const rate = useCallback(() => {
    setOpen(false);
    setQualifyingActionReady(false);
    setClaimedExposureReady(false);
    void authStore.recordStoreRatingNavigation()
      .then((config) => {
        if (mountedRef.current) setState(config.storeRatingPrompt);
      })
      .catch(() => {});
  }, []);

  return {
    listing,
    state,
    open,
    recordMeaningfulAction,
    later,
    never,
    rate,
  };
}
