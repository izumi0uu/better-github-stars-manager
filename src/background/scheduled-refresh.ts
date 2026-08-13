export const WATCH_INBOX_AUTO_REFRESH_ALARM = 'bgsm-watch-inbox-auto-refresh-v1';
export const WATCH_SCOPE_AUTO_REFRESH_ALARM = 'bgsm-watch-scope-auto-refresh-v1';
export const RADAR_AUTO_REFRESH_ALARM = 'bgsm-radar-auto-refresh-v1';
export const RECOMMENDATION_DAILY_REFRESH_ALARM = 'bgsm-recommendations-daily-refresh-v1';

export type ScheduledRefreshKind = 'watch_inbox' | 'watch_scope' | 'radar' | 'recommendations';

type PeriodicScheduledRefresh = Readonly<{
  name: string;
  kind: Exclude<ScheduledRefreshKind, 'recommendations'>;
  delayInMinutes: number;
  periodInMinutes: number;
}>;

export const SCHEDULED_REFRESHES: readonly PeriodicScheduledRefresh[] = Object.freeze([
  {
    name: WATCH_INBOX_AUTO_REFRESH_ALARM,
    kind: 'watch_inbox',
    delayInMinutes: 1,
    periodInMinutes: 1,
  },
  {
    name: WATCH_SCOPE_AUTO_REFRESH_ALARM,
    kind: 'watch_scope',
    delayInMinutes: 15,
    periodInMinutes: 60,
  },
  {
    name: RADAR_AUTO_REFRESH_ALARM,
    kind: 'radar',
    delayInMinutes: 60,
    periodInMinutes: 60,
  },
]);

export interface ScheduledRefreshDependencies {
  getAlarm(name: string): Promise<{ periodInMinutes?: number; scheduledTime?: number } | undefined>;
  createAlarm(
    name: string,
    info: { delayInMinutes: number; periodInMinutes: number } | { when: number },
  ): Promise<void>;
  clearAlarm(name: string): Promise<boolean>;
  addAlarmListener(listener: (name: string) => void): void;
  refreshWatchInbox(): Promise<unknown>;
  refreshWatchScope(): Promise<unknown>;
  refreshRadar(): Promise<unknown>;
  nextRecommendationRefreshAt(nowMillis: number): Promise<number | null> | number | null;
  refreshRecommendationsIfDue(): Promise<unknown>;
  now?: () => number;
  onError(kind: ScheduledRefreshKind | 'schedule', error: unknown): void;
}

export interface ScheduledRefreshController {
  ensure(): Promise<void>;
  handleAlarm(name: string): Promise<void>;
  install(): void;
}

export function createScheduledRefreshController(
  dependencies: ScheduledRefreshDependencies,
): ScheduledRefreshController {
  const now = dependencies.now ?? Date.now;
  let installed = false;

  async function ensureRecommendationAlarm(): Promise<void> {
    const scheduledAt = await dependencies.nextRecommendationRefreshAt(now());
    const current = await dependencies.getAlarm(RECOMMENDATION_DAILY_REFRESH_ALARM);
    if (scheduledAt === null) {
      if (current) await dependencies.clearAlarm(RECOMMENDATION_DAILY_REFRESH_ALARM);
      return;
    }
    if (
      current
      && current.periodInMinutes === undefined
      && current.scheduledTime === scheduledAt
    ) return;
    if (current) await dependencies.clearAlarm(RECOMMENDATION_DAILY_REFRESH_ALARM);
    await dependencies.createAlarm(RECOMMENDATION_DAILY_REFRESH_ALARM, { when: scheduledAt });
  }

  async function ensure(): Promise<void> {
    for (const schedule of SCHEDULED_REFRESHES) {
      const current = await dependencies.getAlarm(schedule.name);
      if (current?.periodInMinutes === schedule.periodInMinutes) continue;
      if (current) await dependencies.clearAlarm(schedule.name);
      await dependencies.createAlarm(schedule.name, {
        delayInMinutes: schedule.delayInMinutes,
        periodInMinutes: schedule.periodInMinutes,
      });
    }
    await ensureRecommendationAlarm();
  }

  async function handleAlarm(name: string): Promise<void> {
    if (name === RECOMMENDATION_DAILY_REFRESH_ALARM) {
      try {
        await dependencies.refreshRecommendationsIfDue();
      } catch (error) {
        dependencies.onError('recommendations', error);
      } finally {
        try {
          await ensureRecommendationAlarm();
        } catch (error) {
          dependencies.onError('schedule', error);
        }
      }
      return;
    }

    const schedule = SCHEDULED_REFRESHES.find((candidate) => candidate.name === name);
    if (!schedule) return;
    try {
      if (schedule.kind === 'watch_inbox') {
        await dependencies.refreshWatchInbox();
      } else if (schedule.kind === 'watch_scope') {
        await dependencies.refreshWatchScope();
      } else {
        await dependencies.refreshRadar();
      }
    } catch (error) {
      dependencies.onError(schedule.kind, error);
    }
  }

  function install(): void {
    if (installed) return;
    installed = true;
    dependencies.addAlarmListener((name) => {
      void handleAlarm(name);
    });
  }

  return { ensure, handleAlarm, install };
}
