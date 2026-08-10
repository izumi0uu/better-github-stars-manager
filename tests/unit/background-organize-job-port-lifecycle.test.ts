import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseControllerId } from '@/bgsm-agent';
import { createBgsmAgentController } from '@/background/organize-job-controller';
import {
  canReplaceBlockedDurableRun,
  resolveBgsmOrganizeJobReconnect,
  settleBgsmOrganizeJobDisconnect,
  resolveBgsmOrganizeControlRole,
} from '@/background/organize-job-port-lifecycle';
import type { ResolvedLaunchCandidate } from '@/background/query';

const candidate: ResolvedLaunchCandidate = {
  contract: { kind: 'all_live_stars' },
  repositoryIds: ['owner/repo'],
  label: 'All stars',
  filterSnapshot: 'all',
};

async function frozenController() {
  let id = 0;
  const controller = createBgsmAgentController({
    resolveCandidate: async () => candidate,
    randomId: () => `id-${++id}`,
    now: () => 100 + id,
  });
  const owner = {
    controllerId: parseControllerId('controller:v1:disconnect'),
    sessionId: `disconnect-${id}`,
  } as const;
  const preflight = await controller.issuePreflight(owner);
  if (!preflight.preflightToken) throw new Error('expected preflight');
  return { controller, owner, frozen: controller.startRun(owner, preflight.preflightToken) };
}

describe('OrganizeJobRun Port lifecycle', () => {
  it('only permits the owning controller session to replace an analysis-blocked durable run', () => {
    const identity = {
      controllerId: parseControllerId('controller:v1:replacement-owner'),
      sessionId: 'replacement-session',
    };
    const blocked = {
      status: 'analysis_blocked' as const,
      controllerId: identity.controllerId,
      sessionId: identity.sessionId,
    };

    assert.equal(canReplaceBlockedDurableRun(blocked, identity), true);
    assert.equal(canReplaceBlockedDurableRun({ ...blocked, status: 'analyzing' }, identity), false);
    assert.equal(canReplaceBlockedDurableRun({ ...blocked, sessionId: 'another-session' }, identity), false);
    assert.equal(canReplaceBlockedDurableRun({
      ...blocked,
      controllerId: parseControllerId('controller:v1:replacement-other'),
    }, identity), false);
  });

  it('projects owner, observer, owner loss, and terminal/no-job roles without mutating authority', () => {
    const owner = {
      controllerId: parseControllerId('controller:v1:role-owner'),
      sessionId: 'role-owner-session',
    } as const;
    const observer = {
      controllerId: parseControllerId('controller:v1:role-observer'),
      sessionId: 'role-observer-session',
    } as const;
    const active = {
      status: 'review' as const,
      controllerId: owner.controllerId,
      sessionId: owner.sessionId,
    };

    assert.equal(resolveBgsmOrganizeControlRole({ page: owner, job: active, ownerConnected: true }), 'owner');
    assert.equal(
      resolveBgsmOrganizeControlRole({ page: observer, job: active, ownerConnected: true }),
      'observer',
    );
    assert.equal(
      resolveBgsmOrganizeControlRole({ page: owner, job: active, ownerConnected: false }),
      'owner_lost',
    );
    assert.equal(
      resolveBgsmOrganizeControlRole({ page: observer, job: active, ownerConnected: false }),
      'owner_lost',
    );
    assert.equal(resolveBgsmOrganizeControlRole({
      page: observer,
      job: { ...active, status: 'completed' },
      ownerConnected: false,
    }), null);
    assert.equal(resolveBgsmOrganizeControlRole({
      page: observer,
      job: { ...active, status: 'cancelled' },
      ownerConnected: true,
    }), null);
    assert.equal(resolveBgsmOrganizeControlRole({ page: observer, job: null, ownerConnected: false }), null);
  });

  it('reports disconnect without aborting or releasing execution authority', async () => {
    const run = await frozenController();
    const posted: unknown[] = [];

    await settleBgsmOrganizeJobDisconnect({
      identity: run.owner,
      controller: run.controller,
      post: (message) => posted.push(message),
    });

    assert.deepEqual(run.controller.getSnapshot(run.frozen), run.frozen);
    assert.deepEqual(posted, [{
      type: 'bgsmOrganizeJobRunDisconnected',
      controllerId: run.owner.controllerId,
      sessionId: run.owner.sessionId,
      runId: run.frozen.runId,
      generation: run.frozen.generation,
    }]);
  });

  it('preserves preflight authority when a page disconnects before start', async () => {
    const controller = createBgsmAgentController({ resolveCandidate: async () => candidate });
    const owner = {
      controllerId: parseControllerId('controller:v1:no-current-disconnect'),
      sessionId: 'no-current-disconnect-session',
    } as const;
    const preflight = await controller.issuePreflight(owner);

    await settleBgsmOrganizeJobDisconnect({ identity: owner, controller });

    assert.ok(controller.findReadyPreflight(owner));
    assert.ok(preflight.preflightToken);
    assert.equal(controller.startRun(owner, preflight.preflightToken).state, 'frozen');
  });

  it('replays an authoritative in-worker snapshot on reconnect', async () => {
    const run = await frozenController();
    const posted: unknown[] = [];
    const observer = {
      controllerId: parseControllerId('controller:v1:reconnect-observer'),
      sessionId: 'reconnect-observer-session',
    } as const;

    await resolveBgsmOrganizeJobReconnect({
      identity: run.frozen,
      page: observer,
      controller: run.controller,
      post: (message) => posted.push(message),
    });

    assert.deepEqual(posted, [{
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: { ...run.controller.getSnapshot(run.frozen), ...observer },
    }]);
  });

  it('reports authoritative loss when a replacement controller cannot restore the run', async () => {
    const run = await frozenController();
    const replacement = createBgsmAgentController({
      resolveCandidate: async () => candidate,
    });
    const posted: unknown[] = [];

    await resolveBgsmOrganizeJobReconnect({
      identity: run.frozen,
      page: run.owner,
      controller: replacement,
      post: (message) => posted.push(message),
    });

    assert.deepEqual(posted, [{
      type: 'bgsmOrganizeJobRunDisconnected',
      controllerId: run.frozen.controllerId,
      sessionId: run.frozen.sessionId,
      runId: run.frozen.runId,
      generation: run.frozen.generation,
    }]);
  });
  it('contains a snapshot lookup failure during disconnect cleanup', async () => {
    const posted: unknown[] = [];
    await settleBgsmOrganizeJobDisconnect({
      identity: {
        controllerId: parseControllerId('controller:v1:disconnect-lookup-failure'),
        sessionId: 'disconnect-lookup-failure-session',
      },
      controller: {
        findLatestSnapshot() {
          throw new Error('ephemeral state unavailable');
        },
      },
      post: (message) => posted.push(message),
    });
    assert.deepEqual(posted, [{
      type: 'bgsmOrganizeJobRunDisconnected',
      controllerId: parseControllerId('controller:v1:disconnect-lookup-failure'),
      sessionId: 'disconnect-lookup-failure-session',
      runId: null,
      generation: null,
    }]);
  });
});
