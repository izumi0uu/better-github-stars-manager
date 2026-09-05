import type {
  RadarActivityPresentation,
  RadarActivityRecord,
  RadarErrorCode,
  RadarPartialReason,
  RadarReconciliationCheckpoint,
  RadarReconciliationPauseReason,
  RadarRefreshMode,
  RadarStateRecord,
} from '@/radar/radar-model';

export type { RadarRefreshMode } from '@/radar/radar-model';
export type RadarRefreshRequest = 'auto' | 'full';


export type RadarSnapshotStatus =
  | 'not_configured'
  | 'never_loaded'
  | 'fresh'
  | 'partial'
  | 'stale'
  | 'error'
  | 'cooldown';

export interface RadarReconciliationStatus {
  phase: RadarReconciliationCheckpoint['cursor']['phase'];
  completedCount: number;
  totalCount: number | null;
  updatedAt: string;
  pauseReason: RadarReconciliationPauseReason | 'interrupted' | null;
  nextAllowedAt: string | null;
}


export interface RadarStatus {
  accountLogin: string | null;
  hasMainToken: boolean;
  refreshing: boolean;
  windowDays: number;
  snapshotStatus: RadarSnapshotStatus;
  errorCode: RadarErrorCode | null;
  state: RadarStateRecord | null;
  reconciliation?: RadarReconciliationStatus | null;
}

export interface RadarQueryResponse {
  activities: RadarActivityPresentation[];
  unseenCount: number;
  status: RadarStatus;
}

export interface RadarRefreshResult {
  published: boolean;
  status: RadarStatus;
}

export interface RadarSourceSnapshot {
  accountLogin: string;
  activities: RadarActivityRecord[];
  windowDays: number;
  refreshMode: RadarRefreshMode;
  lookbackDays: number;
  fetchedAt: string;
  followingCount: number;
  scannedFollowingCount: number;
  batchCount: number;
  partialReasons: RadarPartialReason[];
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  /** Highest GitHub-reported GraphQL request cost observed in this fetch. */
  maxRequestCost?: number | null;
}

export interface RadarReconciliationSourceStep {
  expectedReconciliationId: string;
  expectedRevision: number;
  checkpoint: RadarReconciliationCheckpoint;
  activities: RadarActivityRecord[];
  complete: boolean;
  /** Latest-request cost evidence, separate from the persisted maximum diagnostic. */
  hasCurrentRequestCost: boolean;
}
