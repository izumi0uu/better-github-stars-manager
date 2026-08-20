import type {
  RadarActivityPresentation,
  RadarActivityRecord,
  RadarErrorCode,
  RadarPartialReason,
  RadarStateRecord,
} from '@/radar/radar-model';

export type RadarSnapshotStatus =
  | 'not_configured'
  | 'never_loaded'
  | 'fresh'
  | 'partial'
  | 'stale'
  | 'error'
  | 'cooldown';

export interface RadarStatus {
  accountLogin: string | null;
  hasMainToken: boolean;
  refreshing: boolean;
  windowDays: number;
  snapshotStatus: RadarSnapshotStatus;
  errorCode: RadarErrorCode | null;
  state: RadarStateRecord | null;
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
  fetchedAt: string;
  followingCount: number;
  scannedFollowingCount: number;
  batchCount: number;
  partialReasons: RadarPartialReason[];
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}
