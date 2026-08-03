import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseControllerId } from '@/bgsm-agent';
import { createBgsmAgentController } from '@/background/organize-job-controller';
import {
  canReplaceBlockedDurableRun,
  resolveBgsmOrganizeJobReconnect,
  settleBgsmOrganizeJobDisconnect,
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

  it('aborts scheduling, terminalizes the current run, and releases controller authority', async () => {
    const run = await frozenController();
    const posted: unknown[] = [];
    const released: string[][] = [];
    let aborts = 0;

    await settleBgsmOrganizeJobDisconnect({
      identity: run.owner,
      controller: run.controller,
      abortRun: () => { aborts += 1; },
      releaseRuns: (runIds) => { released.push([...runIds]); },
      post: (message) => posted.push(message),
    });

    assert.equal(aborts, 1);
    assert.deepEqual(released, [[run.frozen.runId]]);
    assert.throws(() => run.controller.getSnapshot(run.frozen), /stale/u);
    assert.deepEqual(posted, [{
      type: 'bgsmOrganizeJobRunDisconnected',
      controllerId: run.owner.controllerId,
      sessionId: run.owner.sessionId,
      runId: run.frozen.runId,
      generation: run.frozen.generation,
    }]);
  });

  it('releases controller and scheduler state when disconnect settlement fails', async () => {
    for (const failurePoint of ['abort', 'disconnect', 'post'] as const) {
      const run = await frozenController();
      const released: string[][] = [];
      const calls: string[] = [];

      await assert.rejects(
        settleBgsmOrganizeJobDisconnect({
          identity: run.owner,
          controller: {
            findLatestSnapshot: (owner) => run.controller.findLatestSnapshot(owner),
            disconnectController: (owner) => {
              calls.push('disconnect');
              if (failurePoint === 'disconnect') throw new Error('disconnect failed');
              return run.controller.disconnectController(owner);
            },
            releaseController: (owner) => {
              calls.push('release-controller');
              return run.controller.releaseController(owner);
            },
          },
          abortRun: () => {
            calls.push('abort');
            if (failurePoint === 'abort') throw new Error('abort failed');
          },
          releaseRuns: (runIds) => {
            calls.push('release-runs');
            released.push([...runIds]);
          },
          post: () => {
            calls.push('post');
            if (failurePoint === 'post') throw new Error('post failed');
          },
        }),
        new RegExp(`${failurePoint} failed`, 'u'),
      );

      assert.deepEqual(calls.slice(-2), ['release-controller', 'release-runs']);
      assert.deepEqual(released, [[run.frozen.runId]]);
      assert.throws(() => run.controller.getSnapshot(run.frozen), /stale/u);
    }
  });

  it('releases preflight authority when the no-current disconnect post fails', async () => {
    const controller = createBgsmAgentController({ resolveCandidate: async () => candidate });
    const owner = {
      controllerId: parseControllerId('controller:v1:no-current-disconnect'),
      sessionId: 'no-current-disconnect-session',
    } as const;
    const preflight = await controller.issuePreflight(owner);
    assert.ok(preflight.preflightToken);
    assert.ok(controller.findReadyPreflight(owner));
    const released: string[][] = [];

    await assert.rejects(
      settleBgsmOrganizeJobDisconnect({
        identity: owner,
        controller,
        abortRun: () => { throw new Error('unexpected abort'); },
        releaseRuns: (runIds) => { released.push([...runIds]); },
        post: () => { throw new Error('post failed'); },
      }),
      /post failed/u,
    );

    assert.deepEqual(released, [[]]);
    assert.equal(controller.findReadyPreflight(owner), null);
    assert.throws(
      () => controller.startRun(owner, preflight.preflightToken!),
      /invalid or stale/u,
    );
  });

  it('replays an authoritative in-worker snapshot on reconnect', async () => {
    const run = await frozenController();
    const posted: unknown[] = [];

    await resolveBgsmOrganizeJobReconnect({
      identity: run.frozen,
      controller: run.controller,
      post: (message) => posted.push(message),
    });

    assert.deepEqual(posted, [{
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: run.controller.getSnapshot(run.frozen),
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
});
