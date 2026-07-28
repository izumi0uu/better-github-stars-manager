import type { DevTraceEvent, DevTraceEventKind, DevTraceTerminalState } from './contracts';
import { DevTraceDB } from './dev-trace-db';
import {
  buildDevTraceEvent,
  type DevTraceEventEnvelope,
  type DevTraceEventInput,
} from './event-builders';

export type DevTraceRootContext = Readonly<{
  rootOperationId: string;
  rootSpanId: string;
  operationKind: DevTraceEventEnvelope['operationKind'];
  clockSegmentId: string;
  startedAt: number;
  disposition?: 'created' | 'resumed_active' | 'resumed_terminal' | 'unavailable';
  terminalStateAtStart?: DevTraceTerminalState | null;
  recordingDisabled?: boolean;
}>;

export type DevTraceRecorder = Readonly<{
  startRoot(input: Readonly<{
    rootOperationId: string;
    operationKind: DevTraceEventEnvelope['operationKind'];
    sessionId: string | null;
    executionEpochId: string;
    attemptId: string | null;
    baseRevision: number | null;
    startedAt?: number;
    activeBeforeTracing?: boolean;
    resumeExisting?: boolean;
  }>): Promise<DevTraceRootContext>;
  startSpan(root: DevTraceRootContext, input: Readonly<{
    spanId: string;
    parentSpanId: string | null;
    spanKind: string;
  }>): Promise<void>;
  emit(root: DevTraceRootContext, spanId: string, parentSpanId: string | null, input: DevTraceEventInput): Promise<void>;
  finishSpan(spanId: string): Promise<void>;
  findLatestEvent(rootOperationId: string, kind: DevTraceEventKind): Promise<DevTraceEvent | null>;
  finishRoot(root: DevTraceRootContext, state: DevTraceTerminalState, reasonCode: string | null): Promise<void>;
  subscribe(listener: (event: ReturnType<typeof buildDevTraceEvent>) => void): () => void;
}>;

export function createDevTraceRecorder(input: Readonly<{
  db?: DevTraceDB;
  now?: () => number;
  monotonicNow?: () => number;
  randomId?: () => string;
  onStorageFailure?: (error: unknown) => void;
}> = {}): DevTraceRecorder {
  const db = input.db ?? new DevTraceDB();
  const now = input.now ?? (() => Date.now());
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const randomId = input.randomId ?? (() => crypto.randomUUID());
  const clockSegmentId = randomId();
  const listeners = new Set<(event: ReturnType<typeof buildDevTraceEvent>) => void>();
  const queues = new Map<string, Promise<void>>();

  function fanOut(event: ReturnType<typeof buildDevTraceEvent>): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Observers cannot affect the recorded operation or other observers.
      }
    }
  }

  function reportStorageFailure(error: unknown): void {
    try {
      input.onStorageFailure?.(error);
    } catch {
      // A diagnostics failure observer is observational too.
    }
  }

  function contain<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    return work().catch((error) => {
      reportStorageFailure(error);
      return fallback;
    });
  }

  function enqueue(rootOperationId: string, work: () => Promise<void>): Promise<void> {
    const previous = queues.get(rootOperationId) ?? Promise.resolve();
    const next = previous.then(work, work).catch(reportStorageFailure);
    queues.set(rootOperationId, next);
    void next.finally(() => {
      if (queues.get(rootOperationId) === next) queues.delete(rootOperationId);
    });
    return next;
  }

  const recorder: DevTraceRecorder = {
    async startRoot(start) {
      const startedAt = start.startedAt ?? now();
      const rootSpanId = `${start.rootOperationId}:root`;
      const requestedRoot = Object.freeze({
        rootOperationId: start.rootOperationId,
        rootSpanId,
        operationKind: start.operationKind,
        clockSegmentId,
        startedAt,
        disposition: 'created' as const,
        terminalStateAtStart: null,
      });
      try {
        const wallTimeMs = now();
        const monotonicOffsetMs = Math.max(0, monotonicNow());
        const opened = await db.openRoot({
          rootOperationId: start.rootOperationId,
          rootSpanId,
          operationKind: start.operationKind,
          sessionId: start.sessionId,
          attemptId: start.attemptId,
          baseRevision: start.baseRevision,
          startedAt,
          activeBeforeTracing: start.activeBeforeTracing,
          resumeExisting: start.resumeExisting ?? false,
          buildStarted: (sequence) => buildDevTraceEvent({
            eventId: randomId(),
            rootOperationId: start.rootOperationId,
            operationKind: start.operationKind,
            spanId: rootSpanId,
            parentSpanId: null,
            sequence,
            wallTimeMs,
            clockSegmentId,
            monotonicOffsetMs,
          }, {
            kind: 'root_started',
            data: {
              executionEpochId: start.executionEpochId,
              attemptId: start.attemptId,
              sessionId: start.sessionId,
              baseRevision: start.baseRevision,
            },
          }),
        });
        if (opened.startedEvent) fanOut(opened.startedEvent);
        return Object.freeze({
          ...requestedRoot,
          startedAt: opened.root.startedAt,
          disposition: opened.disposition,
          terminalStateAtStart: opened.root.terminalState,
        });
      } catch (error) {
        reportStorageFailure(error);
        return Object.freeze({
          ...requestedRoot,
          disposition: 'unavailable' as const,
          recordingDisabled: true,
        });
      }
    },

    async startSpan(root, span) {
      if (root.recordingDisabled) return;
      await contain(() => db.createSpan({
        spanId: span.spanId,
        rootOperationId: root.rootOperationId,
        parentSpanId: span.parentSpanId,
        spanKind: span.spanKind,
        startedAt: now(),
      }), undefined);
    },

    emit(root, spanId, parentSpanId, eventInput) {
      if (root.recordingDisabled) return Promise.resolve();
      return enqueue(root.rootOperationId, async () => {
        const wallTimeMs = now();
        const monotonicOffsetMs = Math.max(0, monotonicNow());
        const event = await db.appendEvent(root.rootOperationId, (sequence) => buildDevTraceEvent({
          eventId: randomId(),
          rootOperationId: root.rootOperationId,
          operationKind: root.operationKind,
          spanId,
          parentSpanId,
          sequence,
          wallTimeMs,
          clockSegmentId: root.clockSegmentId,
          monotonicOffsetMs,
        }, eventInput));
        fanOut(event);
      });
    },

    async finishSpan(spanId) {
      await contain(() => db.finishSpan(spanId, now()), undefined);
    },

    async findLatestEvent(rootOperationId, kind) {
      await queues.get(rootOperationId);
      return contain(() => db.findLatestEvent(rootOperationId, kind), null);
    },

    async finishRoot(root, state, reasonCode) {
      if (root.recordingDisabled || root.terminalStateAtStart) return;
      const endedAt = now();
      await enqueue(root.rootOperationId, async () => {
        const monotonicOffsetMs = Math.max(0, monotonicNow());
        const event = await db.finishRoot({
          rootOperationId: root.rootOperationId,
          rootSpanId: root.rootSpanId,
          endedAt,
          terminalState: state,
          terminalReasonCode: reasonCode,
          buildTerminal: (sequence) => buildDevTraceEvent({
            eventId: randomId(),
            rootOperationId: root.rootOperationId,
            operationKind: root.operationKind,
            spanId: root.rootSpanId,
            parentSpanId: null,
            sequence,
            wallTimeMs: endedAt,
            clockSegmentId: root.clockSegmentId,
            monotonicOffsetMs,
          }, {
            kind: 'root_terminal',
            data: { state, reasonCode, durationMs: Math.max(0, endedAt - root.startedAt) },
          }),
        });
        if (event) fanOut(event);
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return recorder;
}
