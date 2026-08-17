import type { SyncStatus } from '@/utils/messaging';

export type InitialSyncAction = 'syncFull' | 'syncIncremental' | null;

export function pickInitialSyncAction(
  status: Pick<SyncStatus, 'hasToken' | 'starsSyncInFlight'> | null,
  grandTotal: number | null,
): InitialSyncAction {
  if (!status?.hasToken || status.starsSyncInFlight) return null;
  return grandTotal && grandTotal > 0 ? 'syncIncremental' : 'syncFull';
}
