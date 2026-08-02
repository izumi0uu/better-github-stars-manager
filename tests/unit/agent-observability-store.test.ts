import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDevTraceRecorder,
  DEV_TRACE_TOTAL_BYTES_LIMIT,
  DevTraceDB,
  MAX_TRACE_ARTIFACT_BYTES,
  type DevTraceRootContext,
} from '@/agent-observability';

const databases: DevTraceDB[] = [];

function database(
  suffix: string,
  policy = { maxRoots: 20, maxAgeMs: 24 * 60 * 60 * 1_000, maxBytes: 100 * 1024 * 1024 },
): DevTraceDB {
  const db = new DevTraceDB(`bgsm-agent-dev-traces-test-${suffix}-${crypto.randomUUID()}`, policy);
  databases.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (db) => {
    db.close();
    await db.delete();
  }));
});

async function completedRoot(db: DevTraceDB, id: string, time: number): Promise<void> {
  await db.createRoot({ rootOperationId: id, operationKind: 'agent_turn', sessionId: 'session', startedAt: time });
  await db.createSpan({ spanId: `${id}:root`, rootOperationId: id, parentSpanId: null, spanKind: 'root', startedAt: time });
  const recorder = createDevTraceRecorder({
    db,
    now: () => time + 1,
    monotonicNow: () => 1,
    randomId: (() => {
      let index = 0;
      return () => `${id}:event:${++index}`;
    })(),
  });
  const root: DevTraceRootContext = {
    rootOperationId: id,
    rootSpanId: `${id}:root`,
    operationKind: 'agent_turn',
    clockSegmentId: `${id}:clock`,
    startedAt: time,
  };
  await recorder.emit(root, root.rootSpanId, null, {
    kind: 'phase_changed',
    data: { phase: 'working', previousPhase: null },
  });
  await recorder.finishRoot(root, 'completed', null);
}

describe('Agent observability development store', () => {
  it('reserves artifact envelope headroom above retained record bytes', () => {
    expect(MAX_TRACE_ARTIFACT_BYTES).toBeGreaterThan(DEV_TRACE_TOTAL_BYTES_LIMIT);
  });

  it('persists ordered events before live fan-out and exports a validated artifact', async () => {
    const db = database('ordered');
    let wallTime = 100;
    let id = 0;
    const recorder = createDevTraceRecorder({
      db,
      now: () => ++wallTime,
      monotonicNow: () => wallTime - 100,
      randomId: () => `id-${++id}`,
    });
    const observed: number[] = [];
    recorder.subscribe((traceEvent) => observed.push(traceEvent.sequence));
    const root = await recorder.startRoot({
      rootOperationId: 'root-1',
      operationKind: 'agent_turn',
      sessionId: 'session-1',
      executionEpochId: 'epoch-1',
      attemptId: 'attempt-1',
      baseRevision: 0,
    });
    await Promise.all([
      recorder.emit(root, root.rootSpanId, null, { kind: 'phase_changed', data: { phase: 'provider', previousPhase: 'start' } }),
      recorder.emit(root, root.rootSpanId, null, { kind: 'phase_changed', data: { phase: 'tool', previousPhase: 'provider' } }),
    ]);
    await recorder.finishRoot(root, 'completed', null);

    expect(observed).toEqual([1, 2, 3, 4]);
    expect((await db.events.orderBy('[rootOperationId+sequence]').toArray()).map((event) => event.sequence))
      .toEqual([1, 2, 3, 4]);
    const artifact = await db.readArtifact({
      scope: { kind: 'all_retained', id: null },
      exporterVersion: 'test',
      exportedAt: 200,
      build: { versionHash: 'hash', extensionVersion: '1.0.8', runtime: 'dev_page', dev: true },
    });
    expect(artifact.integrity).toEqual({ rootCount: 1, spanCount: 1, eventCount: 4 });
    expect(artifact.roots[0]?.terminalState).toBe('completed');
    const streamed: string[] = [];
    for await (const segment of db.streamArtifactJson({
      scope: { kind: 'all_retained', id: null },
      exporterVersion: 'test',
      exportedAt: 200,
      build: { versionHash: 'hash', extensionVersion: '1.0.8', runtime: 'dev_page', dev: true },
    })) {
      streamed.push(segment);
    }
    expect(JSON.parse(streamed.join(''))).toEqual(artifact);
  });

  it('fences active-root span revisions and event sequences during a streamed snapshot', async () => {
    const db = database('snapshot-fence');
    let eventId = 0;
    const recorder = createDevTraceRecorder({
      db,
      now: () => 100,
      monotonicNow: () => 1,
      randomId: () => `snapshot-event-${++eventId}`,
    });
    const root = await recorder.startRoot({
      rootOperationId: 'agent_turn:snapshot-fence',
      operationKind: 'agent_turn',
      sessionId: 'snapshot-session',
      executionEpochId: 'snapshot-epoch',
      attemptId: 'snapshot-attempt',
      baseRevision: 0,
    });
    await db.createSpan({
      spanId: 'agent_turn:snapshot-fence:child',
      rootOperationId: root.rootOperationId,
      parentSpanId: root.rootSpanId,
      spanKind: 'provider',
      startedAt: 101,
    });
    const iterator = db.streamArtifactJson({
      scope: { kind: 'root', id: root.rootOperationId },
      exporterVersion: 'snapshot-test',
      exportedAt: 150,
      build: { versionHash: 'hash', extensionVersion: '1.0.8', runtime: 'dev_page', dev: true },
    })[Symbol.asyncIterator]();
    const segments = [(await iterator.next()).value!];

    await db.finishSpan('agent_turn:snapshot-fence:child', 200);
    await recorder.emit(root, root.rootSpanId, null, {
      kind: 'phase_changed',
      data: { phase: 'late', previousPhase: 'start' },
    });
    await recorder.finishRoot(root, 'completed', 'late-terminal');
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      segments.push(next.value);
    }

    const artifact = JSON.parse(segments.join('')) as {
      roots: Array<{ terminalState: string | null; eventCount: number }>;
      spans: Array<{ endedAt: number | null }>;
      events: unknown[];
    };
    expect(artifact.roots).toEqual([expect.objectContaining({ terminalState: null, eventCount: 1 })]);
    expect(artifact.spans).toHaveLength(2);
    expect(artifact.spans.every((span) => span.endedAt === null)).toBe(true);
    expect(artifact.events).toHaveLength(1);
  });

  it('leases completed roots until a streamed artifact releases them', async () => {
    const db = database('snapshot-lease', {
      maxRoots: 1,
      maxAgeMs: 10_000,
      maxBytes: 10 * 1024 * 1024,
    });
    await completedRoot(db, 'leased-old', 10);
    const iterator = db.streamArtifactJson({
      scope: { kind: 'all_retained', id: null },
      exporterVersion: 'lease-test',
      exportedAt: 20,
      build: { versionHash: 'hash', extensionVersion: '1.0.8', runtime: 'dev_page', dev: true },
    })[Symbol.asyncIterator]();
    await iterator.next();

    await completedRoot(db, 'new-root', 30);
    expect(await db.roots.get('leased-old')).toBeTruthy();
    expect(await db.roots.get('new-root')).toBeTruthy();

    for (;;) {
      if ((await iterator.next()).done) break;
    }
    await db.cleanup(40);
    expect((await db.roots.toArray()).map((root) => root.rootOperationId)).toEqual(['new-root']);
  });

  it('rejects clear while an artifact snapshot holds a root lease', async () => {
    const db = database('clear-snapshot-lease');
    await completedRoot(db, 'leased-root', 10);
    const iterator = db.streamArtifactJson({
      scope: { kind: 'all_retained', id: null },
      exporterVersion: 'lease-test',
      exportedAt: 20,
      build: { versionHash: 'hash', extensionVersion: '1.0.8', runtime: 'dev_page', dev: true },
    })[Symbol.asyncIterator]();
    await iterator.next();

    await expect(db.clearAll()).rejects.toThrow('Trace artifact snapshot is active.');
    expect(await db.roots.get('leased-root')).toBeTruthy();

    await iterator.return(undefined);
    await db.clearAll();
    expect(await db.roots.count()).toBe(0);
  });

  it('keeps only the newest completed roots while preserving an active root', async () => {
    const db = database('retention', { maxRoots: 3, maxAgeMs: 10_000, maxBytes: 10 * 1024 * 1024 });
    await db.createRoot({ rootOperationId: 'active', operationKind: 'organize_job', sessionId: null, startedAt: 1 });
    await db.createSpan({ spanId: 'active:root', rootOperationId: 'active', parentSpanId: null, spanKind: 'root', startedAt: 1 });
    for (let index = 0; index < 4; index += 1) await completedRoot(db, `completed-${index}`, 10 + index);
    await db.cleanup(20);

    const ids = (await db.roots.orderBy('startedAt').toArray()).map((root) => root.rootOperationId);
    expect(ids).toEqual(['active', 'completed-2', 'completed-3']);
  });

  it('survives close/reopen without using the product database', async () => {
    const name = `bgsm-agent-dev-traces-test-reload-${crypto.randomUUID()}`;
    const first = new DevTraceDB(name);
    await completedRoot(first, 'root-reload', 100);
    first.close();
    const reopened = new DevTraceDB(name);
    databases.push(reopened);
    expect((await reopened.roots.get('root-reload'))?.terminalState).toBe('completed');
    expect(await reopened.events.count()).toBe(2);
  });

  it('atomically clears version 1 traces with legacy acknowledgement dispositions', async () => {
    const name = `bgsm-agent-dev-traces-test-legacy-ack-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      roots: '&rootOperationId, startedAt, endedAt, operationKind, sessionId',
      spans: '&spanId, rootOperationId, [rootOperationId+createdRevision]',
      events: '&eventId, [rootOperationId+sequence], rootOperationId, wallTimeMs, kind',
      meta: '&key',
    });
    await legacy.transaction(
      'rw',
      legacy.table('roots'),
      legacy.table('spans'),
      legacy.table('events'),
      legacy.table('meta'),
      async () => {
        await legacy.table('roots').add({
          rootOperationId: 'legacy-root',
          operationKind: 'agent_turn',
          sessionId: 'legacy-session',
          startedAt: 100,
          endedAt: 110,
        });
        await legacy.table('spans').add({
          spanId: 'legacy-root:span',
          rootOperationId: 'legacy-root',
          createdRevision: 1,
        });
        await legacy.table('events').add({
          eventId: 'legacy-acknowledgement',
          rootOperationId: 'legacy-root',
          operationKind: 'agent_turn',
          spanId: 'legacy-root:span',
          sequence: 1,
          wallTimeMs: 110,
          kind: 'result_acknowledged',
          data: { disposition: 'not_applied', appliedRevision: null },
        });
        await legacy.table('meta').add({ key: 'accounting', totalBytes: 1 });
      },
    );
    legacy.close();

    const upgraded = new DevTraceDB(name);
    databases.push(upgraded);
    await upgraded.open();

    expect(upgraded.verno).toBe(2);
    expect(await Promise.all([
      upgraded.roots.count(),
      upgraded.spans.count(),
      upgraded.events.count(),
      upgraded.meta.count(),
    ])).toEqual([0, 0, 0, 0]);

    await completedRoot(upgraded, 'new-root', 200);
    expect((await upgraded.roots.get('new-root'))?.terminalState).toBe('completed');
    expect(await upgraded.events.count()).toBe(2);
  });

  it('resumes one compatible root with its original clock and preserves the first terminal state', async () => {
    const db = database('resume');
    let eventId = 0;
    const first = createDevTraceRecorder({
      db,
      now: () => 100,
      monotonicNow: () => 1,
      randomId: () => `resume-event-${++eventId}`,
    });
    const second = createDevTraceRecorder({
      db,
      now: () => 900,
      monotonicNow: () => 2,
      randomId: () => `resume-event-${++eventId}`,
    });
    const start = {
      rootOperationId: 'agent_turn:resume-attempt',
      operationKind: 'agent_turn' as const,
      sessionId: 'resume-session',
      executionEpochId: 'epoch-1',
      attemptId: 'resume-attempt',
      baseRevision: 4,
      startedAt: 100,
    };
    const [created, resumed] = await Promise.all([
      first.startRoot(start),
      second.startRoot({ ...start, executionEpochId: 'epoch-2', startedAt: 900, resumeExisting: true }),
    ]);

    expect(new Set([created.disposition, resumed.disposition])).toEqual(new Set(['created', 'resumed_active']));
    expect(created.startedAt).toBe(100);
    expect(resumed.startedAt).toBe(100);
    expect(await db.roots.count()).toBe(1);
    expect(await db.spans.count()).toBe(1);
    expect(await db.events.where('kind').equals('root_started').count()).toBe(1);

    await Promise.all([
      first.finishRoot(created, 'completed', 'final_answer'),
      second.finishRoot(resumed, 'failed', 'late_conflict'),
    ]);
    const terminalRoot = await db.roots.get(start.rootOperationId);
    const terminalEvents = await db.events.where('kind').equals('root_terminal').toArray();
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.data).toMatchObject({
      state: terminalRoot?.terminalState,
      reasonCode: terminalRoot?.terminalReasonCode,
    });

    const terminalResume = await second.startRoot({
      ...start,
      executionEpochId: 'epoch-3',
      startedAt: 1_200,
      resumeExisting: true,
    });
    expect(terminalResume.disposition).toBe('resumed_terminal');
    expect(terminalResume.startedAt).toBe(100);
    await second.emit(terminalResume, terminalResume.rootSpanId, null, {
      kind: 'attempt_rejected',
      data: { reason: 'execution_epoch_mismatch' },
    });
    await second.emit(terminalResume, terminalResume.rootSpanId, null, {
      kind: 'delivery_state',
      data: {
        connectionEpochId: 'connection-resume',
        deliverySequence: 0,
        deliveryKind: 'live',
        durableRevision: null,
      },
    });
    await second.emit(terminalResume, terminalResume.rootSpanId, null, {
      kind: 'port_disconnected',
      data: {
        connectionEpochId: 'connection-resume',
        lastDeliverySequence: 0,
        attemptState: 'rejected',
      },
    });
    await second.finishRoot(terminalResume, 'attempt_state_lost', 'attempt_state_lost');

    const afterResume = await db.roots.get(start.rootOperationId);
    expect(afterResume?.terminalState).toBe(terminalRoot?.terminalState);
    expect(afterResume?.terminalReasonCode).toBe(terminalRoot?.terminalReasonCode);
    expect(await db.events.where('kind').equals('root_terminal').count()).toBe(1);
    const ordered = await db.events.orderBy('[rootOperationId+sequence]').toArray();
    expect(ordered.slice(-3).map((event) => event.kind)).toEqual([
      'attempt_rejected',
      'delivery_state',
      'port_disconnected',
    ]);
  });

  it('turns an incompatible resume into an unwritable observer context', async () => {
    const db = database('resume-conflict');
    const failures: unknown[] = [];
    let eventId = 0;
    const recorder = createDevTraceRecorder({
      db,
      now: () => 100,
      monotonicNow: () => 1,
      randomId: () => `conflict-event-${++eventId}`,
      onStorageFailure: (error) => failures.push(error),
    });
    const root = await recorder.startRoot({
      rootOperationId: 'agent_turn:conflict-attempt',
      operationKind: 'agent_turn',
      sessionId: 'session-original',
      executionEpochId: 'epoch-1',
      attemptId: 'conflict-attempt',
      baseRevision: 1,
      startedAt: 100,
    });
    await recorder.emit(root, root.rootSpanId, null, {
      kind: 'phase_changed',
      data: { phase: 'running', previousPhase: null },
    });
    const eventCountBefore = await db.events.count();

    const incompatible = await recorder.startRoot({
      rootOperationId: 'agent_turn:conflict-attempt',
      operationKind: 'agent_turn',
      sessionId: 'session-conflicting',
      executionEpochId: 'epoch-2',
      attemptId: 'conflict-attempt',
      baseRevision: 1,
      startedAt: 200,
      resumeExisting: true,
    });
    expect(incompatible.disposition).toBe('unavailable');
    await recorder.emit(incompatible, incompatible.rootSpanId, null, {
      kind: 'attempt_rejected',
      data: { reason: 'identity_conflict' },
    });
    await recorder.finishRoot(incompatible, 'attempt_state_lost', 'attempt_state_lost');

    expect(failures).toHaveLength(1);
    expect(await db.roots.count()).toBe(1);
    expect(await db.events.count()).toBe(eventCountBefore);
    expect((await db.roots.get(root.rootOperationId))?.terminalState).toBeNull();
  });

  it('rejects an event whose operation kind does not match its root', async () => {
    const db = database('operation-kind');
    const recorder = createDevTraceRecorder({ db, randomId: () => 'operation-kind-event' });
    const root = await recorder.startRoot({
      rootOperationId: 'agent_turn:operation-kind',
      operationKind: 'agent_turn',
      sessionId: 'session-operation-kind',
      executionEpochId: 'epoch-1',
      attemptId: 'operation-kind',
      baseRevision: 0,
      startedAt: 100,
    });

    await expect(db.appendEvent(root.rootOperationId, (sequence) => ({
      schemaVersion: 1,
      eventId: 'mismatched-operation-event',
      rootOperationId: root.rootOperationId,
      operationKind: 'organize_job',
      spanId: root.rootSpanId,
      parentSpanId: null,
      sequence,
      wallTimeMs: 101,
      clockSegmentId: 'clock-operation-kind',
      monotonicOffsetMs: 1,
      kind: 'phase_changed',
      data: { phase: 'invalid', previousPhase: null },
    }))).rejects.toThrow(/identity does not match/i);
    expect((await db.roots.get(root.rootOperationId))?.eventCount).toBe(1);
  });

  it('contains storage and observer failures without rejecting product work', async () => {
    const failures: unknown[] = [];
    const db = {
      createRoot: async () => { throw new Error('db unavailable'); },
      createSpan: async () => { throw new Error('db unavailable'); },
      appendEvent: async () => { throw new Error('db unavailable'); },
      finishSpan: async () => { throw new Error('db unavailable'); },
      finishRoot: async () => { throw new Error('db unavailable'); },
    } as unknown as DevTraceDB;
    const recorder = createDevTraceRecorder({ db, randomId: () => 'id', onStorageFailure: (error) => failures.push(error) });
    recorder.subscribe(() => { throw new Error('observer unavailable'); });

    const productResult = await (async () => {
      const root = await recorder.startRoot({
        rootOperationId: 'root-failure',
        operationKind: 'agent_turn',
        sessionId: null,
        executionEpochId: 'epoch',
        attemptId: null,
        baseRevision: null,
      });
      await recorder.emit(root, root.rootSpanId, null, { kind: 'phase_changed', data: { phase: 'work', previousPhase: null } });
      await recorder.finishRoot(root, 'completed', null);
      return 'product-success';
    })();

    expect(productResult).toBe('product-success');
    expect(failures.length).toBeGreaterThan(0);
  });
});
