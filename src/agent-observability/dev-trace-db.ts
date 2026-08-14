import Dexie, { type Table } from 'dexie';
import {
  DEV_TRACE_OPERATION_KINDS,
  type DevTraceEvent,
  type DevTraceEventDataByKind,
  type DevTraceOperationKind,
  type DevTraceTerminalState,
  type TraceArtifact,
  type TraceSequenceGap,
  validateTraceArtifact,
} from './contracts';

export const DEV_TRACE_DATABASE_NAME = 'bgsm-agent-dev-traces';
export const DEV_TRACE_ROOT_LIMIT = 20;
export const DEV_TRACE_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const DEV_TRACE_TOTAL_BYTES_LIMIT = 100 * 1024 * 1024;

export type DevTraceRootRecord = Readonly<{
  rootOperationId: string;
  operationKind: DevTraceOperationKind;
  sessionId: string | null;
  attemptId?: string | null;
  baseRevision?: number | null;
  startedAt: number;
  endedAt: number | null;
  terminalState: DevTraceTerminalState | null;
  terminalReasonCode: string | null;
  firstSequence: number;
  lastSequence: number;
  nextSequence: number;
  nextSpanRevision: number;
  eventCount: number;
  totalBytes: number;
  payloadBytes: number;
  droppedEventCount: number;
  truncatedFieldCount: number;
  activeBeforeTracing: boolean;
  sequenceGaps: readonly TraceSequenceGap[];
}>;

export type DevTraceSpanRecord = Readonly<{
  spanId: string;
  rootOperationId: string;
  parentSpanId: string | null;
  spanKind: string;
  startedAt: number;
  endedAt: number | null;
  createdRevision: number;
  endedRevision: number | null;
  payloadBytes: number;
}>;

export type DevTraceEventRecord = Readonly<DevTraceEvent & { payloadBytes: number }>;

export type DevTraceOpenedRoot = Readonly<{
  root: DevTraceRootRecord;
  rootSpan: DevTraceSpanRecord;
  startedEvent: DevTraceEvent | null;
  disposition: 'created' | 'resumed_active' | 'resumed_terminal';
}>;

type DevTraceMetaRecord = Readonly<{
  key: 'accounting';
  totalBytes: number;
  evictedRootCount: number;
  droppedEventCount: number;
  truncatedFieldCount: number;
}>;

type DevTraceArtifactRootFence = Readonly<{
  root: DevTraceRootRecord;
  spanRevision: number;
}>;

export type DevTraceRetentionPolicy = Readonly<{
  maxRoots: number;
  maxAgeMs: number;
  maxBytes: number;
}>;

export type DevTraceArtifactReadInput = Readonly<{
  scope: TraceArtifact['scope'];
  build: TraceArtifact['build'];
  exporterVersion: string;
  exportedAt?: number;
}>;

const DEFAULT_POLICY: DevTraceRetentionPolicy = Object.freeze({
  maxRoots: DEV_TRACE_ROOT_LIMIT,
  maxAgeMs: DEV_TRACE_RETENTION_MS,
  maxBytes: DEV_TRACE_TOTAL_BYTES_LIMIT,
});

const DEV_TRACE_STORES = {
  roots: '&rootOperationId, startedAt, endedAt, operationKind, sessionId',
  spans: '&spanId, rootOperationId, [rootOperationId+createdRevision]',
  events: '&eventId, [rootOperationId+sequence], rootOperationId, wallTimeMs, kind',
  meta: '&key',
} as const;

const artifactRootLeases = new Map<string, number>();
let retentionTail = Promise.resolve();

export class DevTraceDB extends Dexie {
  roots!: Table<DevTraceRootRecord, string>;
  spans!: Table<DevTraceSpanRecord, string>;
  events!: Table<DevTraceEventRecord, string>;
  meta!: Table<DevTraceMetaRecord, string>;

  constructor(
    name = DEV_TRACE_DATABASE_NAME,
    private readonly policy: DevTraceRetentionPolicy = DEFAULT_POLICY,
  ) {
    super(name);
    validatePolicy(policy);
    this.version(1).stores(DEV_TRACE_STORES);
    // Retained diagnostics embed contract unions, so incompatible trace payload changes require a clean dev store.
    this.version(2).stores(DEV_TRACE_STORES).upgrade(async (transaction) => {
      await Promise.all([
        transaction.table('roots').clear(),
        transaction.table('spans').clear(),
        transaction.table('events').clear(),
        transaction.table('meta').clear(),
      ]);
    });
  }

  async createRoot(input: Readonly<{
    rootOperationId: string;
    operationKind: DevTraceOperationKind;
    sessionId: string | null;
    startedAt: number;
    activeBeforeTracing?: boolean;
    attemptId?: string | null;
    baseRevision?: number | null;
  }>): Promise<void> {
    await this.transaction('rw', this.roots, this.meta, async () => {
      if (await this.roots.get(input.rootOperationId)) throw new TypeError('Trace root already exists.');
      const base = {
        rootOperationId: requireId(input.rootOperationId, 'rootOperationId'),
        operationKind: input.operationKind,
        sessionId: input.sessionId,
        attemptId: input.attemptId ?? null,
        baseRevision: input.baseRevision ?? null,
        startedAt: requireTimestamp(input.startedAt, 'startedAt'),
        endedAt: null,
        terminalState: null,
        terminalReasonCode: null,
        firstSequence: 1,
        lastSequence: 0,
        nextSequence: 1,
        nextSpanRevision: 1,
        eventCount: 0,
        totalBytes: 0,
        payloadBytes: 0,
        droppedEventCount: 0,
        truncatedFieldCount: 0,
        activeBeforeTracing: input.activeBeforeTracing ?? false,
        sequenceGaps: [],
      } satisfies DevTraceRootRecord;
      const root = withRootPayloadBytes(base);
      await this.roots.add({ ...root, totalBytes: root.payloadBytes });
      await this.adjustAccounting(root.payloadBytes);
    });
    await this.cleanup(input.startedAt);
  }

  async openRoot(input: Readonly<{
    rootOperationId: string;
    rootSpanId: string;
    operationKind: DevTraceOperationKind;
    sessionId: string | null;
    attemptId: string | null;
    baseRevision: number | null;
    startedAt: number;
    activeBeforeTracing?: boolean;
    resumeExisting: boolean;
    buildStarted(sequence: number): DevTraceEvent;
  }>): Promise<DevTraceOpenedRoot> {
    await this.cleanup(input.startedAt);
    const opened = await this.transaction('rw', this.roots, this.spans, this.events, this.meta, async () => {
      const root = await this.roots.get(input.rootOperationId);
      if (root) {
        if (!input.resumeExisting) throw new TypeError('Trace root already exists.');
        const rootSpan = await this.spans.get(input.rootSpanId);
        const started = await this.events
          .where('[rootOperationId+sequence]')
          .equals([input.rootOperationId, 1])
          .first();
        if (
          root.operationKind !== input.operationKind
          || root.sessionId !== input.sessionId
          || (root.attemptId !== undefined && root.attemptId !== input.attemptId)
          || (root.baseRevision !== undefined && root.baseRevision !== input.baseRevision)
          || !rootSpan
          || rootSpan.rootOperationId !== input.rootOperationId
          || rootSpan.parentSpanId !== null
          || rootSpan.spanKind !== 'root'
          || !started
          || started.kind !== 'root_started'
        ) {
          throw new TypeError('Trace root identity is incompatible with resume.');
        }
        const identity = started.data as DevTraceEventDataByKind['root_started'];
        if (
          identity.attemptId !== input.attemptId
          || identity.sessionId !== input.sessionId
          || identity.baseRevision !== input.baseRevision
          || (root.endedAt === null) !== (root.terminalState === null)
          || (root.endedAt === null) !== (rootSpan.endedAt === null)
        ) {
          throw new TypeError('Trace root identity is incompatible with resume.');
        }
        return {
          root,
          rootSpan,
          startedEvent: null,
          disposition: root.endedAt === null ? 'resumed_active' as const : 'resumed_terminal' as const,
        };
      }

      const rootBase = {
        rootOperationId: requireId(input.rootOperationId, 'rootOperationId'),
        operationKind: input.operationKind,
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        baseRevision: input.baseRevision,
        startedAt: requireTimestamp(input.startedAt, 'startedAt'),
        endedAt: null,
        terminalState: null,
        terminalReasonCode: null,
        firstSequence: 1,
        lastSequence: 0,
        nextSequence: 1,
        nextSpanRevision: 2,
        eventCount: 0,
        totalBytes: 0,
        payloadBytes: 0,
        droppedEventCount: 0,
        truncatedFieldCount: 0,
        activeBeforeTracing: input.activeBeforeTracing ?? false,
        sequenceGaps: [],
      } satisfies DevTraceRootRecord;
      const rootSpanBase = {
        spanId: requireId(input.rootSpanId, 'spanId'),
        rootOperationId: input.rootOperationId,
        parentSpanId: null,
        spanKind: 'root',
        startedAt: input.startedAt,
        endedAt: null,
        createdRevision: 1,
        endedRevision: null,
        payloadBytes: 0,
      } satisfies DevTraceSpanRecord;
      const rootSpan = {
        ...rootSpanBase,
        payloadBytes: serializedBytes(spanProjection(rootSpanBase)),
      };
      const started = input.buildStarted(1);
      assertRootEvent(started, input.rootOperationId, input.rootSpanId, input.operationKind, 1, 'root_started');
      const identity = started.data as DevTraceEventDataByKind['root_started'];
      if (
        identity.attemptId !== input.attemptId
        || identity.sessionId !== input.sessionId
        || identity.baseRevision !== input.baseRevision
      ) {
        throw new TypeError('Trace root start event identity is invalid.');
      }
      const eventRecord: DevTraceEventRecord = {
        ...started,
        payloadBytes: serializedBytes(started),
      };
      const rootWithEvent = withRootPayloadBytes({
        ...rootBase,
        lastSequence: 1,
        nextSequence: 2,
        eventCount: 1,
      });
      const createdRoot = {
        ...rootWithEvent,
        totalBytes: rootWithEvent.payloadBytes + rootSpan.payloadBytes + eventRecord.payloadBytes,
      };
      await this.roots.add(createdRoot);
      await this.spans.add(rootSpan);
      await this.events.add(eventRecord);
      await this.adjustAccounting(createdRoot.totalBytes);
      return {
        root: createdRoot,
        rootSpan,
        startedEvent: started,
        disposition: 'created' as const,
      };
    });
    return opened;
  }

  async createSpan(input: Readonly<{
    spanId: string;
    rootOperationId: string;
    parentSpanId: string | null;
    spanKind: string;
    startedAt: number;
  }>): Promise<void> {
    await this.transaction('rw', this.roots, this.spans, this.meta, async () => {
      const root = await this.requireRoot(input.rootOperationId);
      if (root.endedAt !== null) throw new TypeError('Trace root is already terminal.');
      if (input.parentSpanId !== null) {
        const parent = await this.spans.get(input.parentSpanId);
        if (!parent || parent.rootOperationId !== input.rootOperationId) throw new TypeError('Trace parent span is invalid.');
      }
      const base = {
        spanId: requireId(input.spanId, 'spanId'),
        rootOperationId: input.rootOperationId,
        parentSpanId: input.parentSpanId,
        spanKind: requireId(input.spanKind, 'spanKind'),
        startedAt: requireTimestamp(input.startedAt, 'startedAt'),
        endedAt: null,
        createdRevision: root.nextSpanRevision,
        endedRevision: null,
        payloadBytes: 0,
      } satisfies DevTraceSpanRecord;
      const span = { ...base, payloadBytes: serializedBytes(spanProjection(base)) };
      await this.spans.add(span);
      await this.roots.put({
        ...root,
        nextSpanRevision: root.nextSpanRevision + 1,
        totalBytes: root.totalBytes + span.payloadBytes,
      });
      await this.adjustAccounting(span.payloadBytes);
    });
  }

  async appendEvent(
    rootOperationId: string,
    build: (sequence: number) => DevTraceEvent,
  ): Promise<DevTraceEvent> {
    const event = await this.transaction('rw', this.roots, this.spans, this.events, this.meta, async () => {
      const root = await this.requireRoot(rootOperationId);
      const sequence = root.nextSequence;
      const next = build(sequence);
      if (root.endedAt !== null && !POST_TERMINAL_EVENT_KINDS.has(next.kind)) {
        throw new TypeError('Trace root is already terminal.');
      }
      if (
        next.rootOperationId !== rootOperationId
        || next.operationKind !== root.operationKind
        || next.sequence !== sequence
      ) {
        throw new TypeError('Trace event identity does not match its root allocation.');
      }
      const span = await this.spans.get(next.spanId);
      if (!span || span.rootOperationId !== rootOperationId) throw new TypeError('Trace event span is invalid.');
      const payloadBytes = serializedBytes(next);
      const record: DevTraceEventRecord = { ...next, payloadBytes };
      await this.events.add(record);
      const changed = withRootPayloadBytes({
        ...root,
        lastSequence: sequence,
        nextSequence: sequence + 1,
        eventCount: root.eventCount + 1,
        totalBytes: root.totalBytes + payloadBytes,
      });
      const rootPayloadDelta = changed.payloadBytes - root.payloadBytes;
      await this.roots.put({ ...changed, totalBytes: changed.totalBytes + rootPayloadDelta });
      await this.adjustAccounting(payloadBytes + rootPayloadDelta);
      return next;
    });
    await this.cleanup(event.wallTimeMs);
    return event;
  }

  async finishSpan(spanId: string, endedAt: number): Promise<void> {
    await this.transaction('rw', this.roots, this.spans, this.meta, async () => {
      const current = await this.spans.get(spanId);
      if (!current) throw new TypeError('Trace span does not exist.');
      if (current.endedAt !== null) return;
      const root = await this.requireRoot(current.rootOperationId);
      if (root.endedAt !== null) throw new TypeError('Trace root is already terminal.');
      const changedBase = {
        ...current,
        endedAt: requireTimestamp(endedAt, 'endedAt'),
        endedRevision: root.nextSpanRevision,
        payloadBytes: 0,
      };
      const changed = { ...changedBase, payloadBytes: serializedBytes(spanProjection(changedBase)) };
      const delta = changed.payloadBytes - current.payloadBytes;
      await this.spans.put(changed);
      await this.roots.put({
        ...root,
        nextSpanRevision: root.nextSpanRevision + 1,
        totalBytes: Math.max(0, root.totalBytes + delta),
      });
      await this.adjustAccounting(delta);
    });
  }

  async findLatestEvent(
    rootOperationId: string,
    kind: DevTraceEvent['kind'],
  ): Promise<DevTraceEvent | null> {
    const event = await this.events
      .where('[rootOperationId+sequence]')
      .between(
        [rootOperationId, 0],
        [rootOperationId, Number.MAX_SAFE_INTEGER],
        true,
        true,
      )
      .reverse()
      .filter((candidate) => candidate.kind === kind)
      .first();
    if (!event) return null;
    const { payloadBytes: _payloadBytes, ...traceEvent } = event;
    return traceEvent;
  }

  async finishRoot(input: Readonly<{
    rootOperationId: string;
    rootSpanId: string;
    endedAt: number;
    terminalState: DevTraceTerminalState;
    terminalReasonCode: string | null;
    buildTerminal(sequence: number): DevTraceEvent;
  }>): Promise<DevTraceEvent | null> {
    const terminalEvent = await this.transaction('rw', this.roots, this.spans, this.events, this.meta, async () => {
      const root = await this.requireRoot(input.rootOperationId);
      if (root.endedAt !== null) return null;
      const rootSpan = await this.spans.get(input.rootSpanId);
      if (
        !rootSpan
        || rootSpan.rootOperationId !== input.rootOperationId
        || rootSpan.parentSpanId !== null
        || rootSpan.spanKind !== 'root'
        || rootSpan.endedAt !== null
      ) {
        throw new TypeError('Trace root span is invalid.');
      }
      const endedAt = requireTimestamp(input.endedAt, 'endedAt');
      const sequence = root.nextSequence;
      const event = input.buildTerminal(sequence);
      assertRootEvent(event, input.rootOperationId, input.rootSpanId, root.operationKind, sequence, 'root_terminal');
      const terminalData = event.data as DevTraceEventDataByKind['root_terminal'];
      if (
        terminalData.state !== input.terminalState
        || terminalData.reasonCode !== input.terminalReasonCode
      ) {
        throw new TypeError('Trace root terminal event identity is invalid.');
      }
      const eventRecord: DevTraceEventRecord = {
        ...event,
        payloadBytes: serializedBytes(event),
      };
      const spanBase = {
        ...rootSpan,
        endedAt,
        endedRevision: root.nextSpanRevision,
        payloadBytes: 0,
      };
      const finishedRootSpan = {
        ...spanBase,
        payloadBytes: serializedBytes(spanProjection(spanBase)),
      };
      const spanPayloadDelta = finishedRootSpan.payloadBytes - rootSpan.payloadBytes;
      const changed = withRootPayloadBytes({
        ...root,
        endedAt,
        terminalState: input.terminalState,
        terminalReasonCode: input.terminalReasonCode,
        lastSequence: sequence,
        nextSequence: sequence + 1,
        nextSpanRevision: root.nextSpanRevision + 1,
        eventCount: root.eventCount + 1,
      });
      const rootPayloadDelta = changed.payloadBytes - root.payloadBytes;
      const totalDelta = eventRecord.payloadBytes + spanPayloadDelta + rootPayloadDelta;
      await this.events.add(eventRecord);
      await this.spans.put(finishedRootSpan);
      await this.roots.put({ ...changed, totalBytes: changed.totalBytes + totalDelta });
      await this.adjustAccounting(totalDelta);
      return event;
    });
    await this.cleanup(input.endedAt);
    return terminalEvent;
  }

  async cleanup(now = Date.now()): Promise<void> {
    await withRetentionLock(async () => this.transaction('rw', this.roots, this.spans, this.events, this.meta, async () => {
      const roots = await this.roots.orderBy('startedAt').toArray();
      const leasedRoots = roots.filter((root) => (
        artifactRootLeases.has(artifactLeaseKey(this.name, root.rootOperationId))
      ));
      const completed = roots.filter((root) => (
        root.endedAt !== null && !artifactRootLeases.has(artifactLeaseKey(this.name, root.rootOperationId))
      ));
      const remove = new Set<string>();
      for (const root of completed) {
        if (root.endedAt !== null && root.endedAt < now - this.policy.maxAgeMs) remove.add(root.rootOperationId);
      }
      let retainedRootCount = roots.length - leasedRoots.length - remove.size;
      for (const root of completed) {
        if (retainedRootCount <= this.policy.maxRoots) break;
        if (remove.has(root.rootOperationId)) continue;
        remove.add(root.rootOperationId);
        retainedRootCount -= 1;
      }
      let accounting = await this.accounting();
      let retainedBytes = accounting.totalBytes
        - leasedRoots.reduce((total, root) => total + root.totalBytes, 0)
        - roots
        .filter((root) => remove.has(root.rootOperationId))
        .reduce((total, root) => total + root.totalBytes, 0);
      for (const root of completed) {
        if (retainedBytes <= this.policy.maxBytes) break;
        if (remove.has(root.rootOperationId)) continue;
        remove.add(root.rootOperationId);
        retainedBytes -= root.totalBytes;
      }
      if (remove.size === 0) return;
      const removedRoots = roots.filter((root) => remove.has(root.rootOperationId));
      const removedBytes = removedRoots.reduce((total, root) => total + root.totalBytes, 0);
      for (const root of removedRoots) {
        await this.events.where('rootOperationId').equals(root.rootOperationId).delete();
        await this.spans.where('rootOperationId').equals(root.rootOperationId).delete();
        await this.roots.delete(root.rootOperationId);
      }
      accounting = {
        ...accounting,
        totalBytes: Math.max(0, accounting.totalBytes - removedBytes),
        evictedRootCount: accounting.evictedRootCount + removedRoots.length,
      };
      await this.meta.put(accounting);
    }));
  }

  async *streamArtifactJson(input: DevTraceArtifactReadInput): AsyncGenerator<string> {
    const snapshot = await this.beginArtifactSnapshot(
      input.scope,
      input.exportedAt ?? Date.now(),
    );
    const selectedRoots = snapshot.fences.map(({ root }) => root);
    try {
      const spanCounts = await Promise.all(snapshot.fences.map(async ({ root, spanRevision }) => ({
        rootOperationId: root.rootOperationId,
        spanRevision,
        count: spanRevision === 0 ? 0 : await this.spans
          .where('[rootOperationId+createdRevision]')
          .between([root.rootOperationId, 1], [root.rootOperationId, spanRevision], true, true)
          .count(),
      })));
      const spanCount = spanCounts.reduce((total, entry) => total + entry.count, 0);
      const eventCount = selectedRoots.reduce((total, root) => total + root.eventCount, 0);
      const failedRootCount = selectedRoots.filter((root) => root.terminalState === 'failed').length;
      const roots = selectedRoots.map(rootProjection);
      const completeness = artifactCompleteness(
        selectedRoots,
        snapshot.accounting,
        snapshot.omittedUnsupportedRootCount,
        snapshot.omittedUnsupportedEventCount,
      );

      yield '{"schemaVersion":1,"exporterVersion":';
      yield JSON.stringify(input.exporterVersion);
      yield ',"exportedAt":';
      yield JSON.stringify(snapshot.exportedAt);
      yield ',"scope":';
      yield JSON.stringify(input.scope);
      yield ',"build":';
      yield JSON.stringify(input.build);
      yield ',"completeness":';
      yield JSON.stringify(completeness);
      yield ',"roots":';
      yield JSON.stringify(roots);
      yield ',"spans":[';
      let first = true;
      for (const { rootOperationId, spanRevision } of spanCounts) {
        let nextRevision = 1;
        while (nextRevision <= spanRevision) {
          const rows = await this.spans
            .where('[rootOperationId+createdRevision]')
            .between(
              [rootOperationId, nextRevision],
              [rootOperationId, spanRevision],
              true,
              true,
            )
            .limit(128)
            .toArray();
          if (rows.length === 0) break;
          for (const span of rows) {
            yield `${first ? '' : ','}${JSON.stringify(spanProjectionAtRevision(span, spanRevision))}`;
            first = false;
          }
          nextRevision = rows.at(-1)!.createdRevision + 1;
        }
      }
      yield '],"events":[';
      first = true;
      for (const root of [...selectedRoots].sort((left, right) => (
        left.rootOperationId.localeCompare(right.rootOperationId)
      ))) {
        let nextSequence = root.firstSequence;
        while (nextSequence <= root.lastSequence) {
          const rows = await this.events
            .where('[rootOperationId+sequence]')
            .between(
              [root.rootOperationId, nextSequence],
              [root.rootOperationId, root.lastSequence],
              true,
              true,
            )
            .limit(128)
            .toArray();
          if (rows.length === 0) break;
          for (const { payloadBytes: _payloadBytes, ...event } of rows) {
            yield `${first ? '' : ','}${JSON.stringify(event)}`;
            first = false;
          }
          nextSequence = rows.at(-1)!.sequence + 1;
        }
      }
      yield '],"aggregates":';
      yield JSON.stringify({ rootCount: roots.length, eventCount, failedRootCount });
      yield ',"integrity":';
      yield JSON.stringify({ rootCount: roots.length, spanCount, eventCount });
      yield '}';
    } finally {
      releaseArtifactRoots(this.name, snapshot.fences);
      void this.cleanup(snapshot.exportedAt).catch(() => undefined);
    }
  }

  async readArtifact(input: DevTraceArtifactReadInput): Promise<TraceArtifact> {
    const segments: string[] = [];
    for await (const segment of this.streamArtifactJson(input)) segments.push(segment);
    return validateTraceArtifact(JSON.parse(segments.join('')));
  }

  async clearAll(): Promise<void> {
    await withRetentionLock(async () => {
      if (hasArtifactLeases(this.name)) throw new TypeError('Trace artifact snapshot is active.');
      await this.transaction('rw', this.roots, this.spans, this.events, this.meta, async () => {
        await Promise.all([this.roots.clear(), this.spans.clear(), this.events.clear(), this.meta.clear()]);
      });
    });
  }

  private async requireRoot(rootOperationId: string): Promise<DevTraceRootRecord> {
    const root = await this.roots.get(rootOperationId);
    if (!root) throw new TypeError('Trace root does not exist.');
    return root;
  }

  private async selectedRoots(scope: TraceArtifact['scope']): Promise<DevTraceRootRecord[]> {
    if (scope.kind === 'all_retained') return this.roots.orderBy('startedAt').toArray();
    if (scope.kind === 'root') {
      const root = await this.roots.get(scope.id!);
      return root ? [root] : [];
    }
    return this.roots.where('sessionId').equals(scope.id!).sortBy('startedAt');
  }

  private async beginArtifactSnapshot(
    scope: TraceArtifact['scope'],
    exportedAt: number,
  ): Promise<Readonly<{
    fences: readonly DevTraceArtifactRootFence[];
    accounting: DevTraceMetaRecord;
    exportedAt: number;
    omittedUnsupportedRootCount: number;
    omittedUnsupportedEventCount: number;
  }>> {
    return withRetentionLock(async () => {
      const selected = await this.selectedRoots(scope);
      const roots = selected.filter((root) => DEV_TRACE_OPERATION_KINDS.includes(root.operationKind));
      const supportedRootIds = new Set(roots.map((root) => root.rootOperationId));
      const omitted = selected.filter((root) => !supportedRootIds.has(root.rootOperationId));
      const accounting = await this.accounting();
      const fences = roots.map((root) => ({
        root,
        spanRevision: root.nextSpanRevision - 1,
      }));
      leaseArtifactRoots(this.name, fences);
      return {
        fences,
        accounting,
        exportedAt,
        omittedUnsupportedRootCount: omitted.length,
        omittedUnsupportedEventCount: omitted.reduce((total, root) => total + root.eventCount, 0),
      };
    });
  }

  private async accounting(): Promise<DevTraceMetaRecord> {
    return await this.meta.get('accounting') ?? {
      key: 'accounting',
      totalBytes: 0,
      evictedRootCount: 0,
      droppedEventCount: 0,
      truncatedFieldCount: 0,
    };
  }

  private async adjustAccounting(delta: number): Promise<void> {
    const current = await this.accounting();
    await this.meta.put({ ...current, totalBytes: Math.max(0, current.totalBytes + delta) });
  }
}

const POST_TERMINAL_EVENT_KINDS = new Set<DevTraceEvent['kind']>([
  'attempt_rejected',
  'organize_restore_state',
  'organize_receipt_state',
  'delivery_state',
  'result_acknowledged',
  'port_disconnected',
  'trace_storage_state',
]);

function withRootPayloadBytes<T extends Omit<DevTraceRootRecord, 'payloadBytes'> & { payloadBytes?: number }>(root: T): DevTraceRootRecord {
  const projected = rootProjection(root as DevTraceRootRecord);
  return { ...root, payloadBytes: serializedBytes(projected) } as DevTraceRootRecord;
}

function rootProjection(root: DevTraceRootRecord): Omit<DevTraceRootRecord, 'payloadBytes' | 'totalBytes' | 'nextSequence' | 'nextSpanRevision' | 'terminalReasonCode' | 'droppedEventCount' | 'truncatedFieldCount' | 'activeBeforeTracing' | 'sequenceGaps' | 'attemptId' | 'baseRevision'> {
  return {
    rootOperationId: root.rootOperationId,
    operationKind: root.operationKind,
    sessionId: root.sessionId,
    startedAt: root.startedAt,
    endedAt: root.endedAt,
    terminalState: root.terminalState,
    firstSequence: root.firstSequence,
    lastSequence: root.lastSequence,
    eventCount: root.eventCount,
  };
}

function assertRootEvent(
  event: DevTraceEvent,
  rootOperationId: string,
  rootSpanId: string,
  operationKind: DevTraceOperationKind,
  sequence: number,
  kind: 'root_started' | 'root_terminal',
): void {
  if (
    event.rootOperationId !== rootOperationId
    || event.operationKind !== operationKind
    || event.spanId !== rootSpanId
    || event.parentSpanId !== null
    || event.sequence !== sequence
    || event.kind !== kind
  ) {
    throw new TypeError(`Trace ${kind} event identity is invalid.`);
  }
}

function spanProjection(span: DevTraceSpanRecord): Omit<DevTraceSpanRecord, 'payloadBytes' | 'createdRevision' | 'endedRevision'> {
  return {
    spanId: span.spanId,
    rootOperationId: span.rootOperationId,
    parentSpanId: span.parentSpanId,
    spanKind: span.spanKind,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
  };
}

function spanProjectionAtRevision(
  span: DevTraceSpanRecord,
  revision: number,
): ReturnType<typeof spanProjection> {
  return spanProjection({
    ...span,
    endedAt: span.endedRevision !== null && span.endedRevision <= revision
      ? span.endedAt
      : null,
  });
}

async function withRetentionLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = retentionTail;
  let release!: () => void;
  retentionTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function leaseArtifactRoots(
  databaseName: string,
  fences: readonly DevTraceArtifactRootFence[],
): void {
  for (const { root } of fences) {
    const key = artifactLeaseKey(databaseName, root.rootOperationId);
    artifactRootLeases.set(key, (artifactRootLeases.get(key) ?? 0) + 1);
  }
}

function releaseArtifactRoots(
  databaseName: string,
  fences: readonly DevTraceArtifactRootFence[],
): void {
  for (const { root } of fences) {
    const key = artifactLeaseKey(databaseName, root.rootOperationId);
    const count = artifactRootLeases.get(key) ?? 0;
    if (count <= 1) artifactRootLeases.delete(key);
    else artifactRootLeases.set(key, count - 1);
  }
}

function hasArtifactLeases(databaseName: string): boolean {
  const prefix = `${databaseName}\u0000`;
  return [...artifactRootLeases.keys()].some((key) => key.startsWith(prefix));
}

function artifactLeaseKey(databaseName: string, rootOperationId: string): string {
  return `${databaseName}\u0000${rootOperationId}`;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function artifactCompleteness(
  selectedRoots: readonly DevTraceRootRecord[],
  accounting: DevTraceMetaRecord,
  omittedUnsupportedRootCount = 0,
  omittedUnsupportedEventCount = 0,
): TraceArtifact['completeness'] {
  return {
    retainedFromMs: selectedRoots[0]?.startedAt ?? null,
    retainedToMs: selectedRoots.at(-1)?.endedAt ?? selectedRoots.at(-1)?.startedAt ?? null,
    evictedRootCount: accounting.evictedRootCount,
    droppedEventCount: accounting.droppedEventCount
      + selectedRoots.reduce((total, root) => total + root.droppedEventCount, 0),
    truncatedFieldCount: accounting.truncatedFieldCount
      + selectedRoots.reduce((total, root) => total + root.truncatedFieldCount, 0),
    unknownEventCount: 0,
    omittedUnsupportedRootCount,
    omittedUnsupportedEventCount,
    activeBeforeTracing: selectedRoots.some((root) => root.activeBeforeTracing),
    sequenceGaps: selectedRoots.flatMap((root) => root.sequenceGaps),
  };
}

function requireId(value: string, label: string): string {
  if (!value.trim() || new TextEncoder().encode(value).byteLength > 512) throw new TypeError(`Trace ${label} is invalid.`);
  return value;
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`Trace ${label} is invalid.`);
  return value;
}

function validatePolicy(policy: DevTraceRetentionPolicy): void {
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Trace retention ${key} is invalid.`);
  }
}
