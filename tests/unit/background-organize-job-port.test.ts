import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseControllerId } from '@/bgsm-agent';
import { createBgsmOrganizeJobConnectionRegistry } from '@/background/organize-job-port';
import type { BgsmOrganizeJobDeliveryEnvelope } from '@/utils/messaging';

class FakePort {
  readonly posted: BgsmOrganizeJobDeliveryEnvelope[] = [];
  fail = false;

  postMessage(message: BgsmOrganizeJobDeliveryEnvelope): void {
    if (this.fail) throw new Error('closed');
    this.posted.push(message);
  }
}

const identity = {
  controllerId: parseControllerId('controller:v1:organize-connection'),
  sessionId: 'organize-connection-session',
} as const;

const observerIdentity = {
  controllerId: parseControllerId('controller:v1:organize-observer'),
  sessionId: 'organize-observer-session',
} as const;

describe('OrganizeJobRun connection registry', () => {
  it('rejects leading, trailing, and whitespace-only controller or session IDs', () => {
    const registry = createBgsmOrganizeJobConnectionRegistry<FakePort>();
    const malformedIdentities = [
      { ...identity, controllerId: ` ${identity.controllerId}` },
      { ...identity, controllerId: `${identity.controllerId} ` },
      { ...identity, controllerId: ' ' },
      { ...identity, sessionId: ` ${identity.sessionId}` },
      { ...identity, sessionId: `${identity.sessionId} ` },
      { ...identity, sessionId: ' ' },
    ] as const;

    for (const malformed of malformedIdentities) {
      const port = new FakePort();
      assert.throws(
        () => registry.bind(port, malformed as typeof identity),
        /connection identity is malformed/u,
      );
      assert.equal(registry.forPort(port), null);
    }
  });

  it('rejects client command fields from the durable page identity', () => {
    const registry = createBgsmOrganizeJobConnectionRegistry<FakePort>();
    const port = new FakePort();
    assert.throws(
      () => registry.bind(port, {
        ...identity,
        type: 'requestBgsmOrganizeJobPreflight',
        requestId: 'polluted-page-identity',
        taskInstruction: 'Must not become delivery envelope state.',
      } as typeof identity),
      /must contain only controllerId and sessionId/u,
    );
    assert.equal(registry.forPort(port), null);
  });

  it('binds one immutable identity and emits one monotonic delivery namespace', () => {
    let id = 0;
    const registry = createBgsmOrganizeJobConnectionRegistry<FakePort>({
      randomId: () => `connection-${++id}`,
    });
    const port = new FakePort();
    const bound = registry.bind(port, identity);

    assert.equal(bound.status, 'bound');
    assert.equal(registry.bind(port, identity).status, 'current');
    assert.equal(registry.bind(port, { ...identity, sessionId: 'other-session' }).status, 'identity_mismatch');
    registry.post(port, {
      type: 'bgsmOrganizeJobRunDisconnected',
      ...identity,
      runId: null,
      generation: null,
    });
    registry.post(port, {
      type: 'bgsmOrganizeJobRunDisconnected',
      ...identity,
      runId: null,
      generation: null,
    }, { kind: 'authoritative_snapshot', durableRevision: 7 });

    assert.deepEqual(port.posted.map((delivery) => ({
      epoch: delivery.connectionEpochId,
      sequence: delivery.deliverySequence,
      kind: delivery.deliveryKind,
      revision: delivery.durableRevision,
    })), [
      { epoch: 'organize-connection:v1:connection-1', sequence: 0, kind: 'live', revision: null },
      {
        epoch: 'organize-connection:v1:connection-1',
        sequence: 1,
        kind: 'authoritative_snapshot',
        revision: 7,
      },
    ]);
  });

  it('makes a replaced or disconnected Port observationally stale', () => {
    let id = 0;
    const registry = createBgsmOrganizeJobConnectionRegistry<FakePort>({
      randomId: () => `replacement-${++id}`,
    });
    const firstPort = new FakePort();
    const secondPort = new FakePort();
    const first = registry.bind(firstPort, identity).connection;
    const second = registry.bind(secondPort, identity).connection;

    assert.equal(registry.ownsIdentity(first), false);
    assert.equal(registry.ownsIdentity(second), true);
    assert.equal(registry.bind(firstPort, identity).status, 'stale');
    assert.equal(registry.post(firstPort, {
      type: 'bgsmOrganizeJobRunDisconnected',
      ...identity,
      runId: null,
      generation: null,
    }), null);
    assert.equal(firstPort.posted.length, 0);

    registry.markDisconnected(firstPort);
    assert.equal(registry.ownsIdentity(second), true);
    assert.equal(registry.release(first), true);
    assert.equal(registry.forPort(firstPort), null);
    assert.equal(registry.current(identity), second);
    assert.equal(registry.markDisconnected(secondPort), second);
    assert.equal(registry.current(identity), null);
    assert.equal(registry.release(second), true);
  });

  it('enumerates live subscribers and fans out page-addressed invalidations deterministically', () => {
    let id = 0;
    const registry = createBgsmOrganizeJobConnectionRegistry<FakePort>({
      randomId: () => `subscriber-${++id}`,
    });
    const ownerPort = new FakePort();
    const observerPort = new FakePort();
    const ownerConnection = registry.bind(ownerPort, identity).connection;
    registry.bind(observerPort, observerIdentity);

    assert.equal(registry.hasLivePort(identity), true);
    assert.equal(registry.hasLivePort({ ...identity, sessionId: 'other-session' }), false);
    assert.deepEqual(
      registry.subscribers().map((connection) => connection.identity),
      [identity, observerIdentity],
    );

    const delivered = registry.fanOut((connection) => ({
      type: 'bgsmAgentSessionDeleted',
      ...connection.identity,
      deletedSessionId: 'deleted-session',
    }));

    assert.equal(delivered.length, 2);
    assert.deepEqual(ownerPort.posted[0]?.message, {
      type: 'bgsmAgentSessionDeleted',
      ...identity,
      deletedSessionId: 'deleted-session',
    });
    assert.deepEqual(observerPort.posted[0]?.message, {
      type: 'bgsmAgentSessionDeleted',
      ...observerIdentity,
      deletedSessionId: 'deleted-session',
    });

    assert.equal(registry.markDisconnected(ownerPort), ownerConnection);
    assert.equal(registry.hasLivePort(identity), false);
    assert.deepEqual(registry.subscribers().map((connection) => connection.identity), [observerIdentity]);
    assert.equal(registry.release(ownerConnection), true);
    assert.equal(registry.release(ownerConnection), false);
  });

  it('validates a complete fan-out before sending to any subscriber', () => {
    const registry = createBgsmOrganizeJobConnectionRegistry<FakePort>();
    const ownerPort = new FakePort();
    const observerPort = new FakePort();
    registry.bind(ownerPort, identity);
    registry.bind(observerPort, observerIdentity);

    assert.throws(() => registry.fanOut((connection) => ({
      type: 'bgsmAgentSessionDeleted',
      ...connection.identity,
      deletedSessionId: connection.identity.controllerId === identity.controllerId
        ? 'deleted-session'
        : ' invalid ',
    })), /trimmed and nonempty/u);
    assert.equal(ownerPort.posted.length, 0);
    assert.equal(observerPort.posted.length, 0);
  });

  it('does not consume a delivery sequence when postMessage fails', () => {
    const registry = createBgsmOrganizeJobConnectionRegistry<FakePort>({ randomId: () => 'failed-post' });
    const port = new FakePort();
    const connection = registry.bind(port, identity).connection;
    port.fail = true;
    assert.equal(registry.post(port, {
      type: 'bgsmOrganizeJobRunDisconnected',
      ...identity,
      runId: null,
      generation: null,
    }), null);
    assert.equal(port.posted.length, 0);
    assert.equal(registry.current(identity), null);
    assert.deepEqual(registry.subscribers(), []);
    assert.equal(registry.release(connection), true);
    assert.equal(registry.forPort(port), null);
  });
});
