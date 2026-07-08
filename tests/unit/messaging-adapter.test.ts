import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { bgCall, onProgress, type SyncStatus } from '../../src/utils/messaging';

const sendMessage = vi.fn();
const listeners: Array<(message: unknown) => void> = [];

beforeEach(() => {
  sendMessage.mockReset();
  listeners.length = 0;
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => void) => {
          listeners.push(listener);
        }),
        removeListener: vi.fn((listener: (message: unknown) => void) => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        }),
      },
      onInstalled: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      openOptionsPage: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(),
        set: vi.fn(),
        clear: vi.fn(),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    tabs: {
      create: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('messaging adapter bridge', () => {
  it('unwraps successful background envelope data', async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, data: { count: 2 } });

    const result = await bgCall<{ count: number }>('deleteAllTags', { name: 'react' });

    assert.deepEqual(result, { count: 2 });
    assert.deepEqual(sendMessage.mock.calls[0][0], { type: 'deleteAllTags', name: 'react' });
  });

  it('preserves ok-without-data as undefined', async () => {
    sendMessage.mockResolvedValueOnce({ ok: true });

    const result = await bgCall('syncFull');

    assert.equal(result, undefined);
    assert.deepEqual(sendMessage.mock.calls[0][0], { type: 'syncFull' });
  });

  it('throws background envelope errors', async () => {
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'network-down' });

    await assert.rejects(() => bgCall('syncFull'), /network-down/);
  });

  it('registers progress listeners through the runtime adapter and removes them cleanly', () => {
    const progress: SyncStatus['progress'] = {
      phase: 'full',
      done: 1,
      total: 3,
      message: 'Fetching',
    };
    const callback = vi.fn();

    const unsubscribe = onProgress(callback);
    assert.equal(listeners.length, 1);

    listeners[0]({ type: 'progress', progress });
    assert.equal(callback.mock.calls.length, 1);
    assert.deepEqual(callback.mock.calls[0][0], progress);

    unsubscribe();
    assert.equal(listeners.length, 0);
  });
});
