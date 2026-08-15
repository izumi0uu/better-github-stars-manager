import type { StoreRatingPromptState } from '@/types';

export const STORE_RATING_PROMPT_VERSION = 1 as const;
export const STORE_RATING_REQUIRED_ACTIVE_DAYS = 3;
export const STORE_RATING_REQUIRED_ACTIONS = 3;
export const STORE_RATING_MAX_EXPOSURES = 2;
export const STORE_RATING_SNOOZE_MS = 30 * 24 * 60 * 60 * 1_000;

export const EXTENSION_STORE_TARGETS = [
  'chrome',
  'firefox',
  'edge',
  'opera',
  'none',
] as const;

export type ExtensionStoreTarget = typeof EXTENSION_STORE_TARGETS[number];
export type EnabledExtensionStoreTarget = Exclude<ExtensionStoreTarget, 'none'>;

export type ExtensionStoreListing = Readonly<{
  target: EnabledExtensionStoreTarget;
  label: string;
  ratingUrl: string;
}>;

const CHROME_STORE_LISTING: ExtensionStoreListing = Object.freeze({
  target: 'chrome',
  label: 'Chrome Web Store',
  ratingUrl: 'https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa/reviews',
});

export const DEFAULT_STORE_RATING_PROMPT_STATE: StoreRatingPromptState = Object.freeze({
  version: STORE_RATING_PROMPT_VERSION,
  status: 'tracking',
  activeLocalDays: Object.freeze([]),
  meaningfulActionCount: 0,
  exposureCount: 0,
  snoozeUntil: null,
});

const STORE_RATING_STATUSES = new Set<StoreRatingPromptState['status']>([
  'tracking',
  'snoozed',
  'disabled',
  'store_opened',
  'exhausted',
]);

export type StoreRatingPromptEligibilityReason =
  | 'eligible'
  | 'store_unavailable'
  | 'onboarding_incomplete'
  | 'not_enough_active_days'
  | 'not_enough_meaningful_actions'
  | 'reminders_disabled'
  | 'store_already_opened'
  | 'exposures_exhausted'
  | 'snoozed'
  | 'invalid_snooze'
  | 'not_main_manager'
  | 'no_qualifying_action'
  | 'manager_busy';

export type StoreRatingPromptEligibilityInput = Readonly<{
  state: StoreRatingPromptState;
  listing: ExtensionStoreListing | null;
  now: number;
  onboardingComplete: boolean;
  onMainManager: boolean;
  qualifyingActionReady: boolean;
  managerIdle: boolean;
}>;
type StoredStoreRatingPromptInput = Readonly<{
  version?: unknown;
  status?: unknown;
  activeLocalDays?: unknown;
  meaningfulActionCount?: unknown;
  exposureCount?: unknown;
  snoozeUntil?: unknown;
}>;



function clampCount(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return 0;
  return Math.min(value as number, maximum);
}

function isValidLocalDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

function normalizeSnoozeUntil(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeActiveLocalDays(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isValidLocalDay))]
    .sort()
    .slice(-STORE_RATING_REQUIRED_ACTIVE_DAYS);
}

export function normalizeExtensionStoreTarget(value: unknown): ExtensionStoreTarget {
  return typeof value === 'string'
    && (EXTENSION_STORE_TARGETS as readonly string[]).includes(value)
    ? value as ExtensionStoreTarget
    : 'none';
}

export function resolveExtensionStoreListing(value: unknown): ExtensionStoreListing | null {
  return normalizeExtensionStoreTarget(value) === 'chrome' ? CHROME_STORE_LISTING : null;
}

export const CURRENT_EXTENSION_STORE_LISTING = resolveExtensionStoreListing(
  __GSM_STORE_TARGET__,
);

export function normalizeStoreRatingPromptState(value: unknown): StoreRatingPromptState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_STORE_RATING_PROMPT_STATE, activeLocalDays: [] };
  }
  const input = value as StoredStoreRatingPromptInput;
  if (input.version !== STORE_RATING_PROMPT_VERSION) {
    return { ...DEFAULT_STORE_RATING_PROMPT_STATE, activeLocalDays: [] };
  }

  const status = typeof input.status === 'string'
    && STORE_RATING_STATUSES.has(input.status as StoreRatingPromptState['status'])
    ? input.status as StoreRatingPromptState['status']
    : 'tracking';
  const exposureCount = clampCount(input.exposureCount, STORE_RATING_MAX_EXPOSURES);
  const exhausted = exposureCount >= STORE_RATING_MAX_EXPOSURES
    && (status === 'tracking' || status === 'snoozed');
  const normalizedStatus = exhausted ? 'exhausted' : status;

  return {
    version: STORE_RATING_PROMPT_VERSION,
    status: normalizedStatus,
    activeLocalDays: normalizeActiveLocalDays(input.activeLocalDays),
    meaningfulActionCount: clampCount(
      input.meaningfulActionCount,
      STORE_RATING_REQUIRED_ACTIONS,
    ),
    exposureCount,
    snoozeUntil: normalizedStatus === 'snoozed'
      ? normalizeSnoozeUntil(input.snoozeUntil)
      : null,
  };
}

export function storeRatingLocalDay(now: number | Date): string {
  const date = now instanceof Date ? now : new Date(now);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function recordStoreRatingActiveDay(
  state: StoreRatingPromptState,
  now: number | Date,
): StoreRatingPromptState {
  const localDay = storeRatingLocalDay(now);
  if (state.activeLocalDays.includes(localDay)) return state;
  const activeLocalDays = [...state.activeLocalDays, localDay]
    .sort()
    .slice(-STORE_RATING_REQUIRED_ACTIVE_DAYS);
  return { ...state, activeLocalDays };
}

export function recordStoreRatingMeaningfulAction(
  state: StoreRatingPromptState,
): StoreRatingPromptState {
  if (state.meaningfulActionCount >= STORE_RATING_REQUIRED_ACTIONS) return state;
  return {
    ...state,
    meaningfulActionCount: state.meaningfulActionCount + 1,
  };
}

function stateAllowsExposure(state: StoreRatingPromptState, now: number): boolean {
  if (
    state.activeLocalDays.length < STORE_RATING_REQUIRED_ACTIVE_DAYS
    || state.meaningfulActionCount < STORE_RATING_REQUIRED_ACTIONS
    || state.exposureCount >= STORE_RATING_MAX_EXPOSURES
  ) return false;
  if (state.status === 'tracking') return true;
  if (state.status !== 'snoozed' || state.snoozeUntil === null) return false;
  const snoozeUntil = Date.parse(state.snoozeUntil);
  return Number.isFinite(snoozeUntil) && snoozeUntil <= now;
}

export function consumeStoreRatingPromptExposure(
  state: StoreRatingPromptState,
  now: number,
): StoreRatingPromptState | null {
  if (!stateAllowsExposure(state, now)) return null;
  const exposureCount = state.exposureCount + 1;
  if (exposureCount >= STORE_RATING_MAX_EXPOSURES) {
    return {
      ...state,
      status: 'exhausted',
      exposureCount,
      snoozeUntil: null,
    };
  }
  return {
    ...state,
    status: 'snoozed',
    exposureCount,
    snoozeUntil: new Date(now + STORE_RATING_SNOOZE_MS).toISOString(),
  };
}

export function snoozeStoreRatingPrompt(
  state: StoreRatingPromptState,
  now: number,
): StoreRatingPromptState {
  if (state.status === 'disabled' || state.status === 'store_opened') return state;
  if (state.exposureCount >= STORE_RATING_MAX_EXPOSURES) {
    return { ...state, status: 'exhausted', snoozeUntil: null };
  }
  return {
    ...state,
    status: 'snoozed',
    snoozeUntil: new Date(now + STORE_RATING_SNOOZE_MS).toISOString(),
  };
}

export function disableStoreRatingPrompt(
  state: StoreRatingPromptState,
): StoreRatingPromptState {
  return { ...state, status: 'disabled', snoozeUntil: null };
}

export function recordStoreRatingNavigation(
  state: StoreRatingPromptState,
): StoreRatingPromptState {
  return { ...state, status: 'store_opened', snoozeUntil: null };
}

export function reenableStoreRatingPrompt(
  state: StoreRatingPromptState,
): StoreRatingPromptState {
  return {
    ...state,
    status: 'tracking',
    exposureCount: 0,
    snoozeUntil: null,
  };
}

export function evaluateStoreRatingPromptEligibility({
  state,
  listing,
  now,
  onboardingComplete,
  onMainManager,
  qualifyingActionReady,
  managerIdle,
}: StoreRatingPromptEligibilityInput): StoreRatingPromptEligibilityReason {
  if (!listing) return 'store_unavailable';
  if (!onboardingComplete) return 'onboarding_incomplete';
  if (state.activeLocalDays.length < STORE_RATING_REQUIRED_ACTIVE_DAYS) {
    return 'not_enough_active_days';
  }
  if (state.meaningfulActionCount < STORE_RATING_REQUIRED_ACTIONS) {
    return 'not_enough_meaningful_actions';
  }
  if (state.status === 'disabled') return 'reminders_disabled';
  if (state.status === 'store_opened') return 'store_already_opened';
  if (
    state.status === 'exhausted'
    || state.exposureCount >= STORE_RATING_MAX_EXPOSURES
  ) return 'exposures_exhausted';
  if (state.status === 'snoozed') {
    if (state.snoozeUntil === null || !Number.isFinite(Date.parse(state.snoozeUntil))) {
      return 'invalid_snooze';
    }
    if (Date.parse(state.snoozeUntil) > now) return 'snoozed';
  }
  if (!onMainManager) return 'not_main_manager';
  if (!qualifyingActionReady) return 'no_qualifying_action';
  if (!managerIdle) return 'manager_busy';
  return 'eligible';
}
