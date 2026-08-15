import { describe, expect, it } from 'vitest';
import type { StoreRatingPromptState } from '@/types';
import {
  DEFAULT_STORE_RATING_PROMPT_STATE,
  STORE_RATING_SNOOZE_MS,
  consumeStoreRatingPromptExposure,
  disableStoreRatingPrompt,
  evaluateStoreRatingPromptEligibility,
  normalizeStoreRatingPromptState,
  recordStoreRatingActiveDay,
  recordStoreRatingMeaningfulAction,
  recordStoreRatingNavigation,
  reenableStoreRatingPrompt,
  resolveExtensionStoreListing,
  snoozeStoreRatingPrompt,
  storeRatingLocalDay,
} from '@/store-rating';

const NOW = Date.parse('2026-08-15T12:00:00.000Z');
const CHROME_LISTING = resolveExtensionStoreListing('chrome');

function eligibleState(
  patch: Partial<StoreRatingPromptState> = {},
): StoreRatingPromptState {
  return {
    version: 1,
    status: 'tracking',
    activeLocalDays: ['2026-08-13', '2026-08-14', '2026-08-15'],
    meaningfulActionCount: 3,
    exposureCount: 0,
    snoozeUntil: null,
    ...patch,
  };
}

function eligibility(
  state: StoreRatingPromptState,
  patch: Partial<Parameters<typeof evaluateStoreRatingPromptEligibility>[0]> = {},
) {
  return evaluateStoreRatingPromptEligibility({
    state,
    listing: CHROME_LISTING,
    now: NOW,
    onboardingComplete: true,
    onMainManager: true,
    qualifyingActionReady: true,
    managerIdle: true,
    ...patch,
  });
}

describe('store rating prompt policy', () => {
  it('enables only the verified Chrome destination and fails closed for other targets', () => {
    expect(CHROME_LISTING).toEqual({
      target: 'chrome',
      label: 'Chrome Web Store',
      ratingUrl: 'https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa/reviews',
    });
    expect(resolveExtensionStoreListing('firefox')).toBeNull();
    expect(resolveExtensionStoreListing('edge')).toBeNull();
    expect(resolveExtensionStoreListing('opera')).toBeNull();
    expect(resolveExtensionStoreListing('none')).toBeNull();
    expect(resolveExtensionStoreListing('unknown')).toBeNull();
  });

  it('normalizes missing and malformed persisted values to bounded safe defaults', () => {
    expect(normalizeStoreRatingPromptState(null)).toEqual({
      ...DEFAULT_STORE_RATING_PROMPT_STATE,
      activeLocalDays: [],
    });
    expect(normalizeStoreRatingPromptState({
      version: 1,
      status: 'tracking',
      activeLocalDays: [
        '2026-08-12',
        'invalid',
        '2026-08-13',
        '2026-08-13',
        '2026-08-14',
        '2026-08-15',
      ],
      meaningfulActionCount: 99,
      exposureCount: 2,
      snoozeUntil: 'not-a-date',
    })).toEqual({
      version: 1,
      status: 'exhausted',
      activeLocalDays: ['2026-08-13', '2026-08-14', '2026-08-15'],
      meaningfulActionCount: 3,
      exposureCount: 2,
      snoozeUntil: null,
    });
  });

  it('deduplicates local active days and meaningful actions at their thresholds', () => {
    const localNoon = new Date(2026, 7, 15, 12, 0, 0, 0);
    expect(storeRatingLocalDay(localNoon)).toBe('2026-08-15');

    const firstDay = recordStoreRatingActiveDay(
      { ...DEFAULT_STORE_RATING_PROMPT_STATE, activeLocalDays: [] },
      localNoon,
    );
    expect(recordStoreRatingActiveDay(firstDay, localNoon)).toBe(firstDay);

    const oneAction = recordStoreRatingMeaningfulAction(firstDay);
    const twoActions = recordStoreRatingMeaningfulAction(oneAction);
    const threeActions = recordStoreRatingMeaningfulAction(twoActions);
    expect(recordStoreRatingMeaningfulAction(threeActions)).toBe(threeActions);
    expect(threeActions.meaningfulActionCount).toBe(3);
  });

  it('requires every product and runtime gate', () => {
    const state = eligibleState();
    expect(eligibility(state)).toBe('eligible');
    expect(eligibility(state, { listing: null })).toBe('store_unavailable');
    expect(eligibility(state, { onboardingComplete: false })).toBe('onboarding_incomplete');
    expect(eligibility(eligibleState({ activeLocalDays: ['2026-08-15'] })))
      .toBe('not_enough_active_days');
    expect(eligibility(eligibleState({ meaningfulActionCount: 2 })))
      .toBe('not_enough_meaningful_actions');
    expect(eligibility(state, { onMainManager: false })).toBe('not_main_manager');
    expect(eligibility(state, { qualifyingActionReady: false })).toBe('no_qualifying_action');
    expect(eligibility(state, { managerIdle: false })).toBe('manager_busy');
  });

  it('consumes exposure on show, enforces cooldown, exhausts after two, and re-enables explicitly', () => {
    const firstExposure = consumeStoreRatingPromptExposure(eligibleState(), NOW);
    expect(firstExposure).not.toBeNull();
    expect(firstExposure).toMatchObject({ status: 'snoozed', exposureCount: 1 });
    expect(firstExposure!.snoozeUntil).toBe(
      new Date(NOW + STORE_RATING_SNOOZE_MS).toISOString(),
    );
    expect(eligibility(firstExposure!, { now: NOW + 1 })).toBe('snoozed');
    expect(eligibility(firstExposure!, { now: NOW + STORE_RATING_SNOOZE_MS }))
      .toBe('eligible');

    const secondExposure = consumeStoreRatingPromptExposure(
      firstExposure!,
      NOW + STORE_RATING_SNOOZE_MS,
    );
    expect(secondExposure).toMatchObject({
      status: 'exhausted',
      exposureCount: 2,
      snoozeUntil: null,
    });
    expect(eligibility(secondExposure!)).toBe('exposures_exhausted');

    expect(reenableStoreRatingPrompt(secondExposure!)).toEqual({
      ...secondExposure,
      status: 'tracking',
      exposureCount: 0,
      snoozeUntil: null,
    });
  });

  it('preserves terminal decisions when a stale prompt is snoozed', () => {
    const disabled = disableStoreRatingPrompt(eligibleState());
    const storeOpened = recordStoreRatingNavigation(eligibleState());

    expect(snoozeStoreRatingPrompt(disabled, NOW)).toBe(disabled);
    expect(snoozeStoreRatingPrompt(storeOpened, NOW)).toBe(storeOpened);
    expect(eligibility(disabled)).toBe('reminders_disabled');
    expect(eligibility(storeOpened)).toBe('store_already_opened');

    expect(snoozeStoreRatingPrompt(
      eligibleState({ exposureCount: 2 }),
      NOW,
    )).toMatchObject({ status: 'exhausted', exposureCount: 2 });
    expect(reenableStoreRatingPrompt(disabled).status).toBe('tracking');
    expect(reenableStoreRatingPrompt(storeOpened).status).toBe('tracking');
  });
});
