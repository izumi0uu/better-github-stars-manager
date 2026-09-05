import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { broadcastManagerMessage, type ManagerBroadcastMessage } from '../../src/background/manager-event-transport';

const originalChrome = globalThis.chrome;
afterEach(() => Object.defineProperty(globalThis, 'chrome', { value: originalChrome, configurable: true }));

const events: ManagerBroadcastMessage[] = [
  { type: 'dataChanged' }, { type: 'recommendationsChanged' }, { type: 'radarChanged' },
  { type: 'watchChanged' }, { type: 'watchStatusChanged' },
  { type: 'progress', progress: { phase: 'full', done: 1, total: 2, message: 'fetching' } },
];

describe('Manager event transport', () => {
  for (const event of events) {
    it(`delivers ${event.type} to extension pages and every applicable GitHub tab`, async () => {
      const runtimeSend = vi.fn(async () => undefined);
      const tabSend = vi.fn(async () => undefined);
      const query = vi.fn(async () => [{ id: 11 }, {}, { id: 22 }]);
      Object.defineProperty(globalThis, 'chrome', { value: { runtime: { sendMessage: runtimeSend }, tabs: { query, sendMessage: tabSend } }, configurable: true });
      broadcastManagerMessage(event);
      await Promise.resolve();
      assert.deepEqual(runtimeSend.mock.calls, [[event]]);
      assert.deepEqual(query.mock.calls, [[{ url: 'https://github.com/*' }]]);
      assert.deepEqual(tabSend.mock.calls, [[11, event], [22, event]]);
    });
  }

  it('contains disconnected-page and missing-content-script failures without losing other tab deliveries', async () => {
    const tabSend = vi.fn(async (id: number) => {
      if (id === 11) throw new Error('No receiving end');
    });
    Object.defineProperty(globalThis, 'chrome', { value: {
      runtime: { sendMessage: async () => { throw new Error('No extension pages'); } },
      tabs: { query: async () => [{ id: 11 }, { id: 22 }], sendMessage: tabSend },
    }, configurable: true });
    broadcastManagerMessage({ type: 'dataChanged' });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(tabSend.mock.calls, [[11, { type: 'dataChanged' }], [22, { type: 'dataChanged' }]]);
  });
});
