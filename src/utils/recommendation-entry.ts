import { bgCall } from './messaging';

/** Notify the background that an extension surface became active. */
export function signalRecommendationEntry(): void {
  void bgCall('refreshRecommendationsOnEntry').catch(() => {
    // Entry refresh is opportunistic; surfaces must remain usable when it fails.
  });
}
