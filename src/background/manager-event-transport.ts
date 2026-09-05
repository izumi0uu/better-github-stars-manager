import type { SyncProgress } from '@/types';
import type { WatchStatus } from '@/watch/watch-contract';

export type ManagerBroadcastMessage =
  | { type: 'progress'; progress: SyncProgress }
  | { type: 'watchChanged' | 'watchStatusChanged'; status?: WatchStatus }
  | { type: 'dataChanged' | 'recommendationsChanged' | 'radarChanged' };

/** Invalidation is advisory; a closed page or missing content script cannot fail a commit. */
export function broadcastManagerMessage(message: ManagerBroadcastMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => {});
  if (!chrome.tabs?.query || !chrome.tabs.sendMessage) return;
  void chrome.tabs.query({ url: 'https://github.com/*' }).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      void chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  }).catch(() => {});
}
