import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import {
  digestAgentSessionLaunch,
  type AgentSessionLaunchIdentity,
} from '@/bgsm-agent/session-transport';
import {
  admitAgentSessionTurn,
  createAgentSession,
  settleAgentSessionAttemptWithoutTransition,
} from '@/storage/agent-session-store';
import { db } from '@/storage/db';
import '@/background/index';

type BackgroundResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string; code?: string; details?: unknown };

type BackgroundListener = (
  req: unknown,
  sender: unknown,
  sendResponse: (response: BackgroundResponse) => void,
) => boolean;

const chromeHarness = vi.hoisted(() => {
  type StorageListener = (
    changes: Record<string, { oldValue: unknown; newValue: unknown }>,
    areaName: string,
  ) => void;

  const localState: Record<string, unknown> = {
    gsm_config: { langTagMigrationDone: true },
  };
  const sessionState: Record<string, unknown> = {};
  const storageListeners = new Set<StorageListener>();
  const messageListeners: BackgroundListener[] = [];
  const api = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: localState[key] };
        },
        async set(next: Record<string, unknown>) {
          const changes: Record<string, { oldValue: unknown; newValue: unknown }> = {};
          for (const [key, value] of Object.entries(next)) {
            changes[key] = { oldValue: localState[key], newValue: value };
            localState[key] = value;
          }
          for (const listener of storageListeners) listener(changes, 'local');
        },
        async clear() {
          for (const key of Object.keys(localState)) delete localState[key];
        },
      },
      session: {
        async get(key: string) {
          return key in sessionState ? { [key]: sessionState[key] } : {};
        },
        async set(next: Record<string, unknown>) {
          Object.assign(sessionState, next);
        },
        async remove(key: string) {
          delete sessionState[key];
        },
      },
      onChanged: {
        addListener(listener: StorageListener) {
          storageListeners.add(listener);
        },
        removeListener(listener: StorageListener) {
          storageListeners.delete(listener);
        },
      },
    },
    alarms: {
      async create() {},
      async clear() { return false; },
      onAlarm: { addListener() {} },
    },
    runtime: {
      async sendMessage() {},
      onMessage: {
        addListener(listener: BackgroundListener) {
          messageListeners.push(listener);
        },
      },
      onConnect: { addListener() {} },
      onInstalled: { addListener() {} },
    },
  };

  Object.defineProperty(globalThis, 'chrome', { value: api, configurable: true });
  return { messageListeners };
});

async function sendBackground(req: unknown): Promise<BackgroundResponse> {
  const listener = chromeHarness.messageListeners.at(-1);
  assert.ok(listener, 'background onMessage listener should be registered');
  const responses: BackgroundResponse[] = [];
  assert.equal(listener(req, {}, (response) => responses.push(response)), true);
  await vi.waitFor(() => assert.equal(responses.length, 1));
  return responses[0]!;
}

function launch(sessionId: string): AgentSessionLaunchIdentity {
  return {
    sessionId,
    turnAttemptId: 'attempt-background-mutation',
    baseRevision: 0,
    prompt: 'Preserve this prompt through the background mutation.',
    candidateContract: {
      kind: 'selected_repository',
      selectedRepositoryIdHint: 'owner/repo',
    },
  };
}

describe('background Agent attempt command contract', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterAll(async () => {
    await db.close();
  });

  it('exposes read-only retry projection plus explicit dismiss and discard commands', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-background-attempt' });
    const turn = launch(created.session.id);
    const launchDigest = await digestAgentSessionLaunch(turn);
    await admitAgentSessionTurn({
      ...turn,
      launch: turn,
      launchDigest,
      executionEpochId: 'worker-background-attempt',
    });
    await settleAgentSessionAttemptWithoutTransition({
      sessionId: turn.sessionId,
      turnAttemptId: turn.turnAttemptId,
      launchDigest,
      executionEpochId: 'worker-background-attempt',
      now: () => 1_800_000_000_001,
      outcome: {
        reason: 'aborted',
        changed: false,
        changedCount: 0,
        writeSettlement: 'none',
      },
    });

    const projection = await sendBackground({
      type: 'readAgentRetryDraftCandidate',
      sessionId: turn.sessionId,
    });
    assert.deepEqual(projection, {
      ok: true,
      data: {
        sessionId: turn.sessionId,
        turnAttemptId: turn.turnAttemptId,
        baseRevision: 0,
        prompt: turn.prompt,
        kind: 'stopped',
        settlement: 'retryable',
        updatedAt: 1_800_000_000_001,
      },
    });

    assert.deepEqual(await sendBackground({
      type: 'dismissAgentSessionRetry',
      sessionId: turn.sessionId,
      turnAttemptId: turn.turnAttemptId,
    }), { ok: true, data: true });
    assert.deepEqual(await sendBackground({
      type: 'readAgentRetryDraftCandidate',
      sessionId: turn.sessionId,
    }), { ok: true, data: null });

    const damagedLaunch = { ...turn, turnAttemptId: 'attempt-damaged-recovery' };
    await admitAgentSessionTurn({
      ...damagedLaunch,
      launch: damagedLaunch,
      launchDigest: await digestAgentSessionLaunch(damagedLaunch),
      executionEpochId: 'worker-background-attempt',
    });
    assert.deepEqual(await sendBackground({
      type: 'discardDamagedAgentSessionRecovery',
      sessionId: turn.sessionId,
    }), { ok: true, data: 1 });
    assert.equal(await db.agentAttempts.count(), 1);

    assert.deepEqual(await sendBackground({ type: 'mutateAgentRetryDraft' }), {
      ok: false,
      error: 'Unsupported background request.',
    });
  });
});
