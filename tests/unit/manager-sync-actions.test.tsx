/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useManagerSyncActions } from '@/ui/hooks/use-manager-sync-actions';
import type { BackfillState } from '@/types';
import type { SyncStatus } from '@/utils/messaging';
import { cleanupMountedRootsAndBody, mountReact, type MountedRoot } from './test-utils';

const mountedRoots: MountedRoot[] = [];
const sendMessage = vi.fn();
let latest: ReturnType<typeof useManagerSyncActions> | null = null;
let messageListeners: Array<(message: { type?: string }) => void> = [];
let storageListeners: Array<(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void> = [];

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

  function Probe() {
    latest = useManagerSyncActions({ refreshStars });
    return null;
  }

  mountReact(<Probe />, mountedRoots);

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
  storageListeners = [];
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
    storage: {
      onChanged: {
        addListener: vi.fn((listener) => {
          storageListeners.push(listener);
        }),
        removeListener: vi.fn((listener) => {
          storageListeners = storageListeners.filter((item) => item !== listener);
        }),
      },
    },
  });
});

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  vi.unstubAllGlobals();
});

describe('useManagerSyncActions', () => {
  it('refreshes status on authoritative credential changes without starting a sync', async () => {
    let hasToken = false;
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'getStatus') {
        return ok(baseStatus({
          hasToken,
          onboardingStage: hasToken ? 'done' : 'needs_token',
          seenOnboarding: hasToken,
        }));
      }
      throw new Error(`Unexpected message: ${message.type}`);
    });

    const hook = mountHook();
    await waitFor(() => expect(hook.current.statusLoaded).toBe(true));
    expect(hook.current.status?.hasToken).toBe(false);
    expect(storageListeners).toHaveLength(1);

    await act(async () => {
      storageListeners[0]?.({ gsm_github_credentials: { newValue: {} } }, 'sync');
      storageListeners[0]?.({ gsm_config: { newValue: {} } }, 'local');
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    hasToken = true;
    await act(async () => {
      storageListeners[0]?.({
        gsm_github_credentials: {
          oldValue: { tokenEncrypted: null },
          newValue: { tokenEncrypted: 'ciphertext' },
        },
      }, 'local');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook.current.status?.hasToken).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalledWith({ type: 'syncFull' });
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'query' }));

    const root = mountedRoots.pop();
    act(() => root?.unmount());
    expect(storageListeners).toHaveLength(0);
  });

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

  it('uses catalog labels when the initial automatic sync fails', async () => {
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'getStatus') {
        return ok(baseStatus({ hasToken: true, onboardingStage: 'awaiting_sync', inFlight: false }));
      }
      if (message.type === 'query') return ok({ grandTotal: 0 });
      if (message.type === 'setOnboardingStage') return ok();
      if (message.type === 'syncFull') return fail('initial-down');
      throw new Error(`Unexpected message: ${message.type}`);
    });

    const hook = mountHook();

    await waitFor(() => {
      expect(hook.current.info).toBe('Full re-pull all stars: initial-down');
      expect(hook.current.status?.onboardingStage).toBe('sync_failed');
      expect(hook.current.pendingAction).toBeNull();
    });
  });

  it('runs a backfill action and exposes a success state', async () => {
    const refreshStars = vi.fn();
    const status = baseStatus({
      hasToken: false,
      onboardingStage: 'done',
      backfills: { repo_data_sync: backfillState() },
      activeBackfillId: 'repo_data_sync',
    });
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'getStatus') return ok(status);
      if (message.type === 'runBackfill') return ok();
      throw new Error(`Unexpected message: ${message.type}`);
    });

    const hook = mountHook(refreshStars);
    await waitFor(() => expect(hook.current.statusLoaded).toBe(true));

    await act(async () => {
      await hook.current.runBackfill('repo_data_sync');
    });

    expect(sendMessage).toHaveBeenCalledWith({ type: 'runBackfill', id: 'repo_data_sync' });
    expect(refreshStars).toHaveBeenCalledTimes(1);
    expect(hook.current.successAction).toBe('backfill:repo_data_sync');
    expect(hook.current.pendingAction).toBeNull();
    expect(hook.current.busy).toBe(false);
  });

  it('uses catalog copy when gist pull is missing', async () => {
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'getStatus') return ok(baseStatus({ onboardingStage: 'done' }));
      if (message.type === 'gistPull') return ok({ missing: true });
      throw new Error(`Unexpected message: ${message.type}`);
    });

    const hook = mountHook();
    await waitFor(() => expect(hook.current.statusLoaded).toBe(true));

    await act(async () => {
      await hook.current.doSync('gistPull', 'Pull tags from Gist');
    });

    expect(hook.current.info).toBe(
      'The linked sync Gist was missing; the app unbound it on this device. Push to create a new one.',
    );
    expect(hook.current.successAction).toBeNull();
  });

  it('runs auto tags through the shared manager action lifecycle', async () => {
    const refreshStars = vi.fn();
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'getStatus') return ok(baseStatus({ onboardingStage: 'done' }));
      if (message.type === 'autoAssignTags') return ok();
      throw new Error(`Unexpected message: ${message.type}`);
    });

    const hook = mountHook(refreshStars);
    await waitFor(() => expect(hook.current.statusLoaded).toBe(true));

    await act(async () => {
      await hook.current.autoAssignTags();
    });

    expect(sendMessage).toHaveBeenCalledWith({ type: 'autoAssignTags' });
    expect(refreshStars).toHaveBeenCalledTimes(1);
    expect(hook.current.successAction).toBe('autoAssignTags');
    expect(hook.current.pendingAction).toBeNull();
    expect(hook.current.busy).toBe(false);
  });

  it('uses catalog copy when a backfill action fails', async () => {
    const status = baseStatus({
      hasToken: false,
      onboardingStage: 'done',
      backfills: { repo_data_sync: backfillState() },
      activeBackfillId: 'repo_data_sync',
    });
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'getStatus') return ok(status);
      if (message.type === 'runBackfill') return fail('backfill-down');
      throw new Error(`Unexpected message: ${message.type}`);
    });

    const hook = mountHook();
    await waitFor(() => expect(hook.current.statusLoaded).toBe(true));

    await act(async () => {
      await hook.current.runBackfill('repo_data_sync');
    });

    expect(hook.current.info).toBe('Run Full Sync: backfill-down');
    expect(hook.current.successAction).toBeNull();
  });
});
