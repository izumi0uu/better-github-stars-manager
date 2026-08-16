import { describe, expect, it, vi } from 'vitest';
import {
  createScheduledRefreshController,
  RADAR_AUTO_REFRESH_ALARM,
  RECOMMENDATION_DAILY_REFRESH_ALARM,
  SCHEDULED_REFRESHES,
  WATCH_INBOX_AUTO_REFRESH_ALARM,
  WATCH_SCOPE_AUTO_REFRESH_ALARM,
  type ScheduledRefreshDependencies,
} from '@/background/scheduled-refresh';

const NOW = new Date(2026, 7, 13, 6, 30, 0, 0).getTime();
const NEXT_EIGHT = new Date(2026, 7, 13, 8, 0, 0, 0).getTime();

type StoredAlarm = { periodInMinutes?: number | null; scheduledTime?: number };

function harness(seed: Record<string, StoredAlarm> = {}) {
  const alarms = new Map(Object.entries(seed));
  let listener: ((name: string) => void) | null = null;
  const refreshWatchInbox = vi.fn(async () => undefined);
  const refreshWatchScope = vi.fn(async () => undefined);
  const refreshRadar = vi.fn(async () => undefined);
  const refreshRecommendationsIfDue = vi.fn(async () => undefined);
  const nextRecommendationRefreshAt = vi.fn(() => NEXT_EIGHT as number | null);
  const onError = vi.fn();
  const createAlarm = vi.fn(async (
    name: string,
    info: { delayInMinutes: number; periodInMinutes: number } | { when: number },
  ) => {
    alarms.set(name, 'when' in info
      ? { scheduledTime: info.when }
      : { periodInMinutes: info.periodInMinutes });
  });
  const clearAlarm = vi.fn(async (name: string) => alarms.delete(name));
  const addAlarmListener = vi.fn((next: (name: string) => void) => {
    listener = next;
  });
  const dependencies: ScheduledRefreshDependencies = {
    getAlarm: async (name) => alarms.get(name),
    createAlarm,
    clearAlarm,
    addAlarmListener,
    refreshWatchInbox,
    refreshWatchScope,
    refreshRadar,
    refreshRecommendationsIfDue,
    nextRecommendationRefreshAt,
    now: () => NOW,
    onError,
  };
  return {
    controller: createScheduledRefreshController(dependencies),
    alarms,
    createAlarm,
    clearAlarm,
    addAlarmListener,
    refreshWatchInbox,
    refreshWatchScope,
    refreshRadar,
    refreshRecommendationsIfDue,
    nextRecommendationRefreshAt,
    onError,
    fire(name: string) {
      if (!listener) throw new Error('Alarm listener is not installed');
      listener(name);
    },
  };
}

describe('scheduled Watch, Radar, and recommendation refresh', () => {
  it('keeps periodic jobs and creates one local 08:00 recommendation alarm', async () => {
    const h = harness();

    await h.controller.ensure();

    expect(h.createAlarm.mock.calls).toEqual([
      ...SCHEDULED_REFRESHES.map((schedule) => [
        schedule.name,
        {
          delayInMinutes: schedule.delayInMinutes,
          periodInMinutes: schedule.periodInMinutes,
        },
      ]),
      [RECOMMENDATION_DAILY_REFRESH_ALARM, { when: NEXT_EIGHT }],
    ]);
    expect(h.alarms.get(WATCH_INBOX_AUTO_REFRESH_ALARM)?.periodInMinutes).toBe(1);
    expect(h.alarms.get(WATCH_SCOPE_AUTO_REFRESH_ALARM)?.periodInMinutes).toBe(60);
    expect(h.alarms.get(RADAR_AUTO_REFRESH_ALARM)?.periodInMinutes).toBe(60);
    expect(h.alarms.get(RECOMMENDATION_DAILY_REFRESH_ALARM)).toEqual({ scheduledTime: NEXT_EIGHT });

    h.createAlarm.mockClear();
    await h.controller.ensure();
    expect(h.createAlarm).not.toHaveBeenCalled();
  });

  it('keeps Firefox one-shot alarms whose period is reported as null', async () => {
    const h = harness({
      [WATCH_INBOX_AUTO_REFRESH_ALARM]: { periodInMinutes: 1 },
      [WATCH_SCOPE_AUTO_REFRESH_ALARM]: { periodInMinutes: 60 },
      [RADAR_AUTO_REFRESH_ALARM]: { periodInMinutes: 60 },
      [RECOMMENDATION_DAILY_REFRESH_ALARM]: {
        periodInMinutes: null,
        scheduledTime: NEXT_EIGHT,
      },
    });

    await h.controller.ensure();

    expect(h.clearAlarm).not.toHaveBeenCalled();
    expect(h.createAlarm).not.toHaveBeenCalled();
  });

  it('replaces obsolete schedules without resetting matching jobs', async () => {
    const h = harness({
      [WATCH_INBOX_AUTO_REFRESH_ALARM]: { periodInMinutes: 5 },
      [WATCH_SCOPE_AUTO_REFRESH_ALARM]: { periodInMinutes: 60 },
      [RADAR_AUTO_REFRESH_ALARM]: { periodInMinutes: 60 },
      [RECOMMENDATION_DAILY_REFRESH_ALARM]: { scheduledTime: NEXT_EIGHT - 60_000 },
    });

    await h.controller.ensure();

    expect(h.clearAlarm).toHaveBeenCalledTimes(2);
    expect(h.createAlarm).toHaveBeenCalledWith(
      WATCH_INBOX_AUTO_REFRESH_ALARM,
      { delayInMinutes: 1, periodInMinutes: 1 },
    );
    expect(h.createAlarm).toHaveBeenCalledWith(
      RECOMMENDATION_DAILY_REFRESH_ALARM,
      { when: NEXT_EIGHT },
    );
  });

  it('removes the daily alarm when recommendation scheduling is not eligible', async () => {
    const h = harness({
      [RECOMMENDATION_DAILY_REFRESH_ALARM]: { scheduledTime: NEXT_EIGHT },
    });
    h.nextRecommendationRefreshAt.mockReturnValue(null);

    await h.controller.ensure();

    expect(h.clearAlarm).toHaveBeenCalledWith(RECOMMENDATION_DAILY_REFRESH_ALARM);
  });

  it('installs one listener and routes each alarm to its owning coordinator', async () => {
    const h = harness();
    h.controller.install();
    h.controller.install();

    expect(h.addAlarmListener).toHaveBeenCalledTimes(1);
    h.fire(WATCH_INBOX_AUTO_REFRESH_ALARM);
    h.fire(WATCH_SCOPE_AUTO_REFRESH_ALARM);
    h.fire(RADAR_AUTO_REFRESH_ALARM);
    h.fire(RECOMMENDATION_DAILY_REFRESH_ALARM);
    h.fire('unrelated-alarm');

    await vi.waitFor(() => {
      expect(h.refreshWatchInbox).toHaveBeenCalledTimes(1);
      expect(h.refreshWatchScope).toHaveBeenCalledTimes(1);
      expect(h.refreshRadar).toHaveBeenCalledTimes(1);
      expect(h.refreshRecommendationsIfDue).toHaveBeenCalledTimes(1);
      expect(h.nextRecommendationRefreshAt).toHaveBeenCalledTimes(1);
    });
  });

  it('recomputes the next one-shot alarm after each recommendation alarm', async () => {
    const h = harness({
      [RECOMMENDATION_DAILY_REFRESH_ALARM]: { scheduledTime: NOW },
    });

    await h.controller.handleAlarm(RECOMMENDATION_DAILY_REFRESH_ALARM);

    expect(h.refreshRecommendationsIfDue).toHaveBeenCalledTimes(1);
    expect(h.clearAlarm).toHaveBeenCalledWith(RECOMMENDATION_DAILY_REFRESH_ALARM);
    expect(h.createAlarm).toHaveBeenCalledWith(
      RECOMMENDATION_DAILY_REFRESH_ALARM,
      { when: NEXT_EIGHT },
    );
  });

  it('contains refresh failures inside the alarm boundary and still repairs the schedule', async () => {
    const h = harness();
    h.refreshRecommendationsIfDue.mockRejectedValueOnce(new Error('offline'));

    await h.controller.handleAlarm(RECOMMENDATION_DAILY_REFRESH_ALARM);

    expect(h.onError).toHaveBeenCalledWith('recommendations', expect.any(Error));
    expect(h.createAlarm).toHaveBeenCalledWith(
      RECOMMENDATION_DAILY_REFRESH_ALARM,
      { when: NEXT_EIGHT },
    );
  });
});
