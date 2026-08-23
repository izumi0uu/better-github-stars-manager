import type { RadarStateRecord } from '@/radar/radar-model';
import type { FollowingHistoryWindowDays } from '@/types';

export const RADAR_INCREMENTAL_LOOKBACK_DAYS = 7 as const;
export const RADAR_FULL_RECONCILIATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

export type RadarRefreshPlanReason =
  | 'forced'
  | 'no_baseline'
  | 'incomplete'
  | 'window_expanded'
  | 'credential_changed'
  | 'full_reconciliation_due'
  | 'stable_baseline';
export interface RadarPolicyState {
  windowDays?: number | null;
  lastFullReconciledAt?: string | null;
  lastRefreshMode?: 'full' | 'incremental' | null;
  lastIncrementalAt?: string | null;
  credentialIdentity?: string | null;
  errorCode?: RadarStateRecord['errorCode'];
  partialReasons?: RadarStateRecord['partialReasons'];
}

export interface RadarRefreshPolicyInput {
  nowMillis: number;
  selectedWindowDays: FollowingHistoryWindowDays;
  credentialIdentity: string;
  state: RadarPolicyState | null;
  forceFull?: boolean;
}

export interface RadarRefreshPlan {
  mode: 'full' | 'incremental';
  lookbackDays: FollowingHistoryWindowDays | typeof RADAR_INCREMENTAL_LOOKBACK_DAYS;
  reason: RadarRefreshPlanReason;
}

function parsedTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

export function selectRadarRefreshPlan(input: RadarRefreshPolicyInput): RadarRefreshPlan {
  const full = (reason: Exclude<RadarRefreshPlanReason, 'stable_baseline'>): RadarRefreshPlan => ({
    mode: 'full',
    lookbackDays: input.selectedWindowDays,
    reason,
  });

  if (input.forceFull) return full('forced');

  const state = input.state;
  const lastFullMillis = parsedTimestamp(state?.lastFullReconciledAt);
  if (!state || lastFullMillis === null) return full('no_baseline');

  if (
    state.errorCode !== null && state.errorCode !== undefined
    || (state.partialReasons?.length ?? 0) > 0
  ) return full('incomplete');
  if (
    state.windowDays === null
    || state.windowDays === undefined
    || input.selectedWindowDays > state.windowDays
  ) return full('window_expanded');
  if (
    state.credentialIdentity === null
    || state.credentialIdentity === undefined
    || state.credentialIdentity !== input.credentialIdentity
  ) return full('credential_changed');

  if (input.nowMillis - lastFullMillis >= RADAR_FULL_RECONCILIATION_INTERVAL_MS) {
    return full('full_reconciliation_due');
  }

  return {
    mode: 'incremental',
    lookbackDays: RADAR_INCREMENTAL_LOOKBACK_DAYS,
    reason: 'stable_baseline',
  };
}
