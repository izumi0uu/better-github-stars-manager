/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStoreRatingPrompt } from '@/ui/hooks/use-store-rating-prompt';
import type { StoreRatingPromptState } from '@/types';
import type { ExtensionStoreListing } from '@/store-rating';
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  type MountedRoot,
} from './test-utils';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  recordActiveDay: vi.fn(),
  recordMeaningfulAction: vi.fn(),
  consumeExposure: vi.fn(),
  snooze: vi.fn(),
  disable: vi.fn(),
  recordNavigation: vi.fn(),
  reenable: vi.fn(),
  bgCall: vi.fn(),
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  authStore: {
    getConfig: mocks.getConfig,
    recordStoreRatingActiveDay: mocks.recordActiveDay,
    recordStoreRatingMeaningfulAction: mocks.recordMeaningfulAction,
    consumeStoreRatingPromptExposure: mocks.consumeExposure,
    snoozeStoreRatingPrompt: mocks.snooze,
    disableStoreRatingPrompt: mocks.disable,
    recordStoreRatingNavigation: mocks.recordNavigation,
    reenableStoreRatingPrompt: mocks.reenable,
  },
}));

vi.mock('@/utils/messaging', () => ({
  bgCall: mocks.bgCall,
}));

const listing: ExtensionStoreListing = {
  target: 'chrome',
  label: 'Chrome Web Store',
  ratingUrl: 'https://example.com/reviews',
};
const eligibleState: StoreRatingPromptState = {
  version: 1,
  status: 'tracking',
  activeLocalDays: ['2026-08-13', '2026-08-14', '2026-08-15'],
  meaningfulActionCount: 3,
  exposureCount: 0,
  snoozeUntil: null,
};
const claimedState: StoreRatingPromptState = {
  ...eligibleState,
  status: 'snoozed',
  exposureCount: 1,
  snoozeUntil: '2026-09-14T12:00:00.000Z',
};
const idleStatus = {
  progress: { phase: 'idle', done: 0, total: null, message: '' },
  hasToken: true,
  onboardingStage: 'done',
  seenOnboarding: true,
  seenTooltips: 0,
  backfills: {},
  activeBackfillId: null,
  inFlight: false,
  organizeJobActive: false,
};
const mountedRoots: MountedRoot[] = [];

function Harness({ managerIdle = true }: { managerIdle?: boolean }) {
  const prompt = useStoreRatingPrompt({
    onboardingComplete: true,
    onMainManager: true,
    managerIdle,
    listing,
    now: () => Date.parse('2026-08-15T12:00:00.000Z'),
  });
  return (
    <div data-open={prompt.open ? 'true' : 'false'}>
      <button type="button" onClick={() => { void prompt.recordMeaningfulAction(); }}>
        Complete action
      </button>
    </div>
  );
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function emitStoredPromptState(nextState: StoreRatingPromptState) {
  const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0]?.[0];
  if (!listener) throw new Error('Missing storage listener');
  act(() => {
    listener({
      gsm_config: { newValue: { storeRatingPrompt: nextState } },
    }, 'local');
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.stubGlobal('chrome', {
    storage: {
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
  mocks.getConfig.mockResolvedValue({ storeRatingPrompt: eligibleState });
  mocks.recordActiveDay.mockResolvedValue({ storeRatingPrompt: eligibleState });
  mocks.recordMeaningfulAction.mockResolvedValue({ storeRatingPrompt: eligibleState });
  mocks.consumeExposure.mockResolvedValue({
    config: { storeRatingPrompt: claimedState },
    consumed: true,
  });
  mocks.bgCall.mockResolvedValue(idleStatus);
});

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useStoreRatingPrompt', () => {
  it('claims an eligible exposure only after a qualifying success in an idle manager', async () => {
    const container = mountReact(<Harness />, mountedRoots);
    await flushEffects();

    expect(container.firstElementChild?.getAttribute('data-open')).toBe('false');
    expect(mocks.consumeExposure).not.toHaveBeenCalled();

    const action = container.querySelector('button');
    if (!(action instanceof HTMLButtonElement)) throw new Error('Missing action');
    await click(action);
    await flushEffects();

    expect(mocks.bgCall).toHaveBeenCalledWith('getStatus');
    expect(mocks.consumeExposure).toHaveBeenCalledWith(
      Date.parse('2026-08-15T12:00:00.000Z'),
    );
    expect(container.firstElementChild?.getAttribute('data-open')).toBe('true');
  });

  it('keeps a claimed exposure pending until the manager becomes idle again', async () => {
    const claim = Promise.withResolvers<{
      config: { storeRatingPrompt: StoreRatingPromptState };
      consumed: boolean;
    }>();
    mocks.consumeExposure.mockReturnValue(claim.promise);
    const container = mountReact(<Harness />, mountedRoots);
    await flushEffects();

    const action = container.querySelector('button');
    if (!(action instanceof HTMLButtonElement)) throw new Error('Missing action');
    await click(action);
    await flushEffects();
    expect(mocks.consumeExposure).toHaveBeenCalledTimes(1);

    act(() => {
      mountedRoots[0]?.render(<Harness managerIdle={false} />);
    });
    await act(async () => {
      claim.resolve({
        config: { storeRatingPrompt: claimedState },
        consumed: true,
      });
      await Promise.resolve();
    });
    await flushEffects();

    expect(container.firstElementChild?.getAttribute('data-open')).toBe('false');
    act(() => {
      mountedRoots[0]?.render(<Harness managerIdle />);
    });
    await flushEffects();

    expect(mocks.consumeExposure).toHaveBeenCalledTimes(1);
    expect(container.firstElementChild?.getAttribute('data-open')).toBe('true');
  });

  it('opens after the durable claim storage update cancels the claiming effect', async () => {
    const claim = Promise.withResolvers<{
      config: { storeRatingPrompt: StoreRatingPromptState };
      consumed: boolean;
    }>();
    mocks.consumeExposure.mockReturnValue(claim.promise);
    const container = mountReact(<Harness />, mountedRoots);
    await flushEffects();

    const action = container.querySelector('button');
    if (!(action instanceof HTMLButtonElement)) throw new Error('Missing action');
    await click(action);
    await flushEffects();
    expect(mocks.consumeExposure).toHaveBeenCalledTimes(1);

    emitStoredPromptState(claimedState);
    await act(async () => {
      claim.resolve({
        config: { storeRatingPrompt: claimedState },
        consumed: true,
      });
      await Promise.resolve();
    });
    await flushEffects();

    expect(mocks.consumeExposure).toHaveBeenCalledTimes(1);
    expect(container.firstElementChild?.getAttribute('data-open')).toBe('true');
  });

  it.each([
    ['Stars sync', {
      ...idleStatus,
      progress: { ...idleStatus.progress, phase: 'incremental' as const },
      inFlight: true,
    }],
    ['backfill', { ...idleStatus, activeBackfillId: 'backfill-1' }],
    ['Organize job', { ...idleStatus, organizeJobActive: true }],
  ])('rechecks automatically after authoritative %s activity clears', async (_label, busyStatus) => {
    vi.useFakeTimers();
    mocks.bgCall
      .mockResolvedValueOnce(busyStatus)
      .mockResolvedValueOnce(idleStatus);
    const container = mountReact(<Harness />, mountedRoots);
    await flushEffects();

    const action = container.querySelector('button');
    if (!(action instanceof HTMLButtonElement)) throw new Error('Missing action');
    await click(action);
    await flushEffects();

    expect(mocks.bgCall).toHaveBeenCalledTimes(1);
    expect(mocks.consumeExposure).not.toHaveBeenCalled();
    expect(container.firstElementChild?.getAttribute('data-open')).toBe('false');

    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushEffects();

    expect(mocks.recordMeaningfulAction).toHaveBeenCalledTimes(1);
    expect(mocks.bgCall).toHaveBeenCalledTimes(3);
    expect(mocks.consumeExposure).toHaveBeenCalledTimes(1);
    expect(container.firstElementChild?.getAttribute('data-open')).toBe('true');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed without polling after an authoritative status check fails', async () => {
    vi.useFakeTimers();
    mocks.bgCall.mockRejectedValue(new Error('worker unavailable'));
    const container = mountReact(<Harness />, mountedRoots);
    await flushEffects();

    const action = container.querySelector('button');
    if (!(action instanceof HTMLButtonElement)) throw new Error('Missing action');
    await click(action);
    await flushEffects();

    expect(mocks.bgCall).toHaveBeenCalledTimes(1);
    expect(mocks.consumeExposure).not.toHaveBeenCalled();
    expect(container.firstElementChild?.getAttribute('data-open')).toBe('false');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['disabled', 'store_opened'] as const)(
    'closes and disarms an open prompt when storage changes to %s',
    async (status) => {
      const container = mountReact(<Harness />, mountedRoots);
      await flushEffects();

      const action = container.querySelector('button');
      if (!(action instanceof HTMLButtonElement)) throw new Error('Missing action');
      await click(action);
      await flushEffects();
      expect(container.firstElementChild?.getAttribute('data-open')).toBe('true');

      emitStoredPromptState({ ...claimedState, status, snoozeUntil: null });
      expect(container.firstElementChild?.getAttribute('data-open')).toBe('false');

      emitStoredPromptState(eligibleState);
      await flushEffects();
      expect(mocks.bgCall).toHaveBeenCalledTimes(2);
      expect(mocks.consumeExposure).toHaveBeenCalledTimes(1);
    },
  );

  it('cleans up a pending recheck timer and storage listener on unmount', async () => {
    vi.useFakeTimers();
    mocks.bgCall.mockResolvedValue({ ...idleStatus, organizeJobActive: true });
    const container = mountReact(<Harness />, mountedRoots);
    await flushEffects();

    const action = container.querySelector('button');
    if (!(action instanceof HTMLButtonElement)) throw new Error('Missing action');
    await click(action);
    await flushEffects();
    expect(vi.getTimerCount()).toBe(1);

    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0]?.[0];
    const root = mountedRoots.pop();
    if (!listener || !root) throw new Error('Missing mounted prompt listener');
    act(() => root.unmount());

    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(listener);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.bgCall).toHaveBeenCalledTimes(1);
  });

  it('does not claim while the manager UI is busy', async () => {
    const container = mountReact(<Harness managerIdle={false} />, mountedRoots);
    await flushEffects();

    const action = container.querySelector('button');
    if (!(action instanceof HTMLButtonElement)) throw new Error('Missing action');
    await click(action);
    await flushEffects();

    expect(mocks.bgCall).not.toHaveBeenCalled();
    expect(mocks.consumeExposure).not.toHaveBeenCalled();
    expect(container.firstElementChild?.getAttribute('data-open')).toBe('false');
  });
});
