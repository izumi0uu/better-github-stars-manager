export const WATCH_INBOX_AUTO_REFRESH_ALARM = 'bgsm-watch-inbox-auto-refresh-v1';
export const WATCH_SCOPE_AUTO_REFRESH_ALARM = 'bgsm-watch-scope-auto-refresh-v1';
export const RADAR_AUTO_REFRESH_ALARM = 'bgsm-radar-auto-refresh-v1';

export type ScheduledRefreshKind = 'watch_inbox' | 'watch_scope' | 'radar';

type ScheduledRefresh = Readonly<{
  name: string;
  kind: ScheduledRefreshKind;
  delayInMinutes: number;
  periodInMinutes: number;
}>;

export const SCHEDULED_REFRESHES: readonly ScheduledRefresh[] = Object.freeze([
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
  getAlarm(name: string): Promise<{ periodInMinutes?: number } | undefined>;
  createAlarm(
    name: string,
    info: { delayInMinutes: number; periodInMinutes: number },
  ): Promise<void>;
  clearAlarm(name: string): Promise<boolean>;
  addAlarmListener(listener: (name: string) => void): void;
  refreshWatchInbox(): Promise<unknown>;
  refreshWatchScope(): Promise<unknown>;
  refreshRadar(): Promise<unknown>;
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
  let installed = false;

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
  }

  async function handleAlarm(name: string): Promise<void> {
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
