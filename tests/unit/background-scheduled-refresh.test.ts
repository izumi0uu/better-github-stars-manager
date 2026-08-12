import { describe, expect, it, vi } from 'vitest';
import {
  createScheduledRefreshController,
  RADAR_AUTO_REFRESH_ALARM,
  SCHEDULED_REFRESHES,
  WATCH_INBOX_AUTO_REFRESH_ALARM,
  WATCH_SCOPE_AUTO_REFRESH_ALARM,
  type ScheduledRefreshDependencies,
} from '@/background/scheduled-refresh';

function harness(seed: Record<string, number> = {}) {
  const alarms = new Map(
    Object.entries(seed).map(([name, periodInMinutes]) => [name, { periodInMinutes }]),
  );
  let listener: ((name: string) => void) | null = null;
  const refreshWatchInbox = vi.fn(async () => undefined);
  const refreshWatchScope = vi.fn(async () => undefined);
  const refreshRadar = vi.fn(async () => undefined);
  const onError = vi.fn();
  const createAlarm = vi.fn(async (
    name: string,
    info: { delayInMinutes: number; periodInMinutes: number },
  ) => {
    alarms.set(name, { periodInMinutes: info.periodInMinutes });
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
    onError,
    fire(name: string) {
      if (!listener) throw new Error('Alarm listener is not installed');
      listener(name);
    },
  };
}

describe('scheduled Watch and Radar refresh', () => {
  it('creates stable one-minute Watch and hourly scope/Radar alarms', async () => {
    const h = harness();

    await h.controller.ensure();

    expect(h.createAlarm.mock.calls).toEqual(SCHEDULED_REFRESHES.map((schedule) => [
      schedule.name,
      {
        delayInMinutes: schedule.delayInMinutes,
        periodInMinutes: schedule.periodInMinutes,
      },
    ]));
    expect(h.alarms.get(WATCH_INBOX_AUTO_REFRESH_ALARM)?.periodInMinutes).toBe(1);
    expect(h.alarms.get(WATCH_SCOPE_AUTO_REFRESH_ALARM)?.periodInMinutes).toBe(60);
    expect(h.alarms.get(RADAR_AUTO_REFRESH_ALARM)?.periodInMinutes).toBe(60);

    h.createAlarm.mockClear();
    await h.controller.ensure();
    expect(h.createAlarm).not.toHaveBeenCalled();
  });

  it('replaces an obsolete period without resetting matching schedules', async () => {
    const h = harness({
      [WATCH_INBOX_AUTO_REFRESH_ALARM]: 5,
      [WATCH_SCOPE_AUTO_REFRESH_ALARM]: 60,
      [RADAR_AUTO_REFRESH_ALARM]: 60,
    });

    await h.controller.ensure();

    expect(h.clearAlarm).toHaveBeenCalledTimes(1);
    expect(h.clearAlarm).toHaveBeenCalledWith(WATCH_INBOX_AUTO_REFRESH_ALARM);
    expect(h.createAlarm).toHaveBeenCalledTimes(1);
    expect(h.createAlarm).toHaveBeenCalledWith(
      WATCH_INBOX_AUTO_REFRESH_ALARM,
      { delayInMinutes: 1, periodInMinutes: 1 },
    );
  });

  it('installs one listener and routes each alarm to its owning coordinator', async () => {
    const h = harness();
    h.controller.install();
    h.controller.install();

    expect(h.addAlarmListener).toHaveBeenCalledTimes(1);
    h.fire(WATCH_INBOX_AUTO_REFRESH_ALARM);
    h.fire(WATCH_SCOPE_AUTO_REFRESH_ALARM);
    h.fire(RADAR_AUTO_REFRESH_ALARM);
    h.fire('unrelated-alarm');

    await vi.waitFor(() => {
      expect(h.refreshWatchInbox).toHaveBeenCalledTimes(1);
      expect(h.refreshWatchScope).toHaveBeenCalledTimes(1);
      expect(h.refreshRadar).toHaveBeenCalledTimes(1);
    });
  });

  it('contains refresh failures inside the alarm boundary', async () => {
    const h = harness();
    h.refreshRadar.mockRejectedValueOnce(new Error('offline'));

    await h.controller.handleAlarm(RADAR_AUTO_REFRESH_ALARM);

    expect(h.onError).toHaveBeenCalledWith('radar', expect.any(Error));
  });
});
