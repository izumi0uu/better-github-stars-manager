/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useManagerSyncActions } from '@/ui/hooks/use-manager-sync-actions';
import type { BackfillState } from '@/types';
import type { SyncStatus } from '@/utils/messaging';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const sendMessage = vi.fn();
let latest: ReturnType<typeof useManagerSyncActions> | null = null;
let messageListeners: Array<(message: { type?: string }) => void> = [];

function baseStatus(patch: Partial<SyncStatus> = {}): SyncStatus {
  const backfills = patch.backfills ?? {};
  return {
    progress: { phase: 'idle', done: 0, total: null, message: '' },
    hasToken: false,
    onboardingStage: 'needs_token',
    seenOnboarding: false,
    seenTooltips: 0,
    backfills,
    activeBackfillId: null,
    inFlight: false,
    ...patch,
  };
}

function backfillState(patch: Partial<BackfillState> = {}): BackfillState {
  return {
    status: 'pending',
    queuedAt: null,
    lastAttemptAt: null,
    completedAt: null,
    error: null,
    ...patch,
  };
}

function ok(data?: unknown) {
  return Promise.resolve({ ok: true, data });
}

function fail(error: string) {
  return Promise.resolve({ ok: false, error });
}

function mountHook(refreshStars = vi.fn()) {
  latest = null;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Probe() {
    latest = useManagerSyncActions({ refreshStars });
    return null;
  }

  act(() => {
    root.render(<Probe />);
  });
  mountedRoots.push(root);

  return {
    refreshStars,
    get current() {
      if (!latest) throw new Error('useManagerSyncActions did not render');
      return latest;
    },
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let i = 0; i < 25; i += 1) {
    await flushEffects();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

beforeEach(() => {
  messageListeners = [];
  sendMessage.mockReset();
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: vi.fn((listener) => {
          messageListeners.push(listener);
        }),
        removeListener: vi.fn((listener) => {
          messageListeners = messageListeners.filter((item) => item !== listener);
        }),
      },
    },
  });
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  vi.unstubAllGlobals();
});

describe('useManagerSyncActions', () => {
  it('runs the initial sync and advances onboarding after data appears', async () => {
    const refreshStars = vi.fn();
    const queryGrandTotals = [0, 3];
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'getStatus') {
        return ok(baseStatus({ hasToken: true, onboardingStage: 'awaiting_sync' }));
      }
      if (message.type === 'query') {
        return ok({ grandTotal: queryGrandTotals.shift() ?? 3 });
      }
      if (message.type === 'setOnboardingStage') return ok();
      if (message.type === 'syncFull') return ok();
      throw new Error(`Unexpected message: ${message.type}`);
    });

    const hook = mountHook(refreshStars);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({ type: 'syncFull' });
      expect(refreshStars).toHaveBeenCalledTimes(1);
      expect(hook.current.status?.onboardingStage).toBe('coach');
      expect(hook.current.pendingAction).toBeNull();
    });

    expect(sendMessage).toHaveBeenCalledWith({ type: 'setOnboardingStage', stage: 'syncing' });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'setOnboardingStage', stage: 'coach' });
  });

  it('keeps sync failure visible and marks onboarding as failed', async () => {
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'getStatus') {
        return ok(baseStatus({ hasToken: true, onboardingStage: 'awaiting_sync', inFlight: true }));
      }
      if (message.type === 'setOnboardingStage') return ok();
      if (message.type === 'syncFull') return fail('network-down');
      throw new Error(`Unexpected message: ${message.type}`);
    });

    const hook = mountHook();
    await waitFor(() => expect(hook.current.statusLoaded).toBe(true));

    await act(async () => {
      await hook.current.doSync('syncFull', 'Full sync');
    });

    expect(sendMessage).toHaveBeenCalledWith({ type: 'setOnboardingStage', stage: 'syncing' });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'setOnboardingStage', stage: 'sync_failed' });
    expect(hook.current.status?.onboardingStage).toBe('sync_failed');
    expect(hook.current.info).toContain('network-down');
    expect(hook.current.pendingAction).toBeNull();
  });

  it('runs a backfill action and exposes a success state', async () => {
    const refreshStars = vi.fn();
    const status = baseStatus({
      hasToken: false,
      onboardingStage: 'done',
      backfills: { repo_data_sync_v1: backfillState() },
      activeBackfillId: 'repo_data_sync_v1',
    });
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'getStatus') return ok(status);
      if (message.type === 'runBackfill') return ok();
      throw new Error(`Unexpected message: ${message.type}`);
    });

    const hook = mountHook(refreshStars);
    await waitFor(() => expect(hook.current.statusLoaded).toBe(true));

    await act(async () => {
      await hook.current.runBackfill('repo_data_sync_v1');
    });

    expect(sendMessage).toHaveBeenCalledWith({ type: 'runBackfill', id: 'repo_data_sync_v1' });
    expect(refreshStars).toHaveBeenCalledTimes(1);
    expect(hook.current.successAction).toBe('backfill:repo_data_sync_v1');
    expect(hook.current.pendingAction).toBeNull();
    expect(hook.current.busy).toBe(false);
  });
});
