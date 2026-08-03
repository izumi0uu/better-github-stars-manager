import {
  serializeAgentCaptureMessages,
  type AgentContentCaptureRequestIdentity,
  type AgentContentCaptureSink,
} from '@/agent-harness/content-capture';
import {
  type DevRawCaptureContentKind,
  type DevRawCaptureEvent,
  type DevRawCaptureEventData,
  type DevTracePortResponse,
} from './dev-protocol';
import {
  buildRawCaptureField,
  RAW_CAPTURE_EVENT_MAX_BYTES,
  RAW_CAPTURE_FIELD_MAX_BYTES,
  RAW_CAPTURE_PENDING_QUEUE_MAX_BYTES,
  RAW_CAPTURE_ROOT_MAX_BYTES,
  scrubRawCaptureText,
  truncateUtf8,
  utf8Bytes,
  type RawCaptureField,
} from './redaction';

export type DevRawCapturePort = Readonly<{
  postMessage(message: DevTracePortResponse): void;
}>;

export type DevRawCaptureCoordinator = Readonly<{
  arm(owner: DevRawCapturePort): Promise<
    | Readonly<{ kind: 'armed'; captureId: string }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  disarm(owner: DevRawCapturePort): string | null;
  disconnect(owner: DevRawCapturePort): void;
  beginRoot(input: Readonly<{ rootOperationId: string }>): AgentContentCaptureSink | undefined;
}>;

type CaptureLimits = Readonly<{
  fieldBytes: number;
  eventBytes: number;
  rootBytes: number;
  pendingQueueBytes: number;
}>;

type DropReason = Extract<
  DevRawCaptureEventData,
  { kind: 'evidence_dropped' }
>['reason'];

type PendingDelivery = Readonly<{
  message: DevRawCaptureEvent;
  bytes: number;
}>;

type ArmingState = {
  kind: 'arming';
  owner: DevRawCapturePort;
  captureId: string;
};

type ArmedState = {
  kind: 'armed';
  owner: DevRawCapturePort;
  captureId: string;
  secrets: string[];
};

type ActiveState = {
  kind: 'active';
  owner: DevRawCapturePort;
  captureId: string;
  rootOperationId: string;
  secrets: string[];
  sequence: number;
  retainedBytes: number;
  queuedBytes: number;
  contentEventCount: number;
  truncatedFieldCount: number;
  droppedEventCount: number;
  droppedBytes: number;
  droppedByReason: Map<DropReason, { count: number; bytes: number }>;
  queue: PendingDelivery[];
  drainScheduled: boolean;
  destroyed: boolean;
  finishedReason: string | null;
};

type CaptureState = ArmingState | ArmedState | ActiveState;

const ROOT_MARKER_RESERVE_MAX_BYTES = 4 * 1024;
const RAW_CAPTURE_COORDINATE_MAX_BYTES = 512;

export function createDevRawCaptureCoordinator(input: Readonly<{
  getConfiguredSecrets: () => Promise<readonly (string | null | undefined)[]>;
  randomId?: () => string;
  scheduleDrain?: (callback: () => void) => void;
  limits?: Partial<CaptureLimits>;
}>): DevRawCaptureCoordinator {
  const randomId = input.randomId ?? defaultRandomId;
  const scheduleDrain = input.scheduleDrain ?? queueMicrotask;
  const limits = normalizeLimits(input.limits);
  let state: CaptureState | null = null;

  const destroy = (target: CaptureState): void => {
    if (target.kind === 'armed') target.secrets.splice(0);
    if (target.kind === 'active') {
      target.destroyed = true;
      target.secrets.splice(0);
      target.queue.splice(0);
      target.queuedBytes = 0;
    }
    if (state === target) state = null;
  };

  const arm: DevRawCaptureCoordinator['arm'] = async (owner) => {
    if (state !== null) return { kind: 'unavailable' };
    const arming: ArmingState = {
      kind: 'arming',
      owner,
      captureId: `raw_capture:${randomId()}`,
    };
    state = arming;
    let secrets: readonly (string | null | undefined)[];
    try {
      secrets = await input.getConfiguredSecrets();
    } catch (error) {
      if (state === arming) state = null;
      throw error;
    }
    if (state !== arming) return { kind: 'unavailable' };
    state = {
      kind: 'armed',
      owner,
      captureId: arming.captureId,
      secrets: [...new Set(secrets.filter((secret): secret is string => !!secret))],
    };
    return { kind: 'armed', captureId: arming.captureId };
  };

  const disarm: DevRawCaptureCoordinator['disarm'] = (owner) => {
    if (!state || state.owner !== owner) return null;
    const captureId = state.captureId;
    destroy(state);
    return captureId;
  };

  const disconnect: DevRawCaptureCoordinator['disconnect'] = (owner) => {
    if (state?.owner === owner) destroy(state);
  };

  const beginRoot: DevRawCaptureCoordinator['beginRoot'] = ({ rootOperationId }) => {
    if (state?.kind !== 'armed') return undefined;
    const armed = state;
    const active: ActiveState = {
      kind: 'active',
      owner: armed.owner,
      captureId: armed.captureId,
      rootOperationId,
      secrets: armed.secrets,
      sequence: 0,
      retainedBytes: 0,
      queuedBytes: 0,
      contentEventCount: 0,
      truncatedFieldCount: 0,
      droppedEventCount: 0,
      droppedBytes: 0,
      droppedByReason: new Map(),
      queue: [],
      drainScheduled: false,
      destroyed: false,
      finishedReason: null,
    };
    state = active;
    enqueue(active, { kind: 'root_started' }, false);

    const content = (
      kind: DevRawCaptureContentKind,
      text: string,
      coordinates: Readonly<{
        identity?: AgentContentCaptureRequestIdentity;
        providerStep?: number;
        toolName?: string;
        toolCallId?: string;
      }>,
    ): void => {
      if (state !== active || active.destroyed || active.finishedReason !== null) return;
      let field = buildRawCaptureField(text, active.secrets, limits.fieldBytes);
      const toolName = scrubCoordinate(coordinates.toolName, active.secrets);
      const toolCallId = scrubCoordinate(coordinates.toolCallId, active.secrets);
      const base = {
        kind,
        requestId: coordinates.identity?.requestId ?? null,
        requestKind: coordinates.identity?.requestKind ?? null,
        providerStep: coordinates.identity?.providerStep
          ?? coordinates.providerStep
          ?? null,
        requestAttempt: coordinates.identity?.requestAttempt ?? null,
        toolName: toolName.text,
        toolNameTruncated: toolName.truncated,
        toolCallId: toolCallId.text,
        toolCallIdTruncated: toolCallId.truncated,
      } as const;
      field = fitFieldToEvent(active, base, field);
      const event = { ...base, content: field } satisfies DevRawCaptureEventData;
      if (!eventFits(active, event)) {
        recordDrop(active, 'event_limit', serializedBytes(delivery(active, event)));
        return;
      }
      if (enqueue(active, event, true)) {
        active.truncatedFieldCount += Number(field.truncated)
          + Number(toolName.truncated)
          + Number(toolCallId.truncated);
        active.contentEventCount += 1;
      }
    };

    return {
      providerPrompt(identity, messages) {
        content('provider_prompt', serializeAgentCaptureMessages(messages), { identity });
      },
      providerResponse(identity, response) {
        if (response.content !== undefined) {
          content('provider_response', response.content, { identity });
        }
        if (response.refusal !== undefined) {
          content('provider_refusal', response.refusal, { identity });
        }
      },
      toolArguments(tool) {
        content('tool_arguments', tool.content, tool);
      },
      toolResult(tool) {
        content('tool_result', tool.content, tool);
      },
      finish(reason) {
        if (active.destroyed || active.finishedReason !== null) return;
        active.finishedReason = reason;
        active.secrets.splice(0);
        schedule(active);
      },
    };
  };

  function enqueue(
    active: ActiveState,
    event: DevRawCaptureEventData,
    enforceContentBudget: boolean,
  ): boolean {
    if (active.destroyed) return false;
    const message = delivery(active, event);
    const bytes = serializedBytes(message);
    if (bytes > limits.eventBytes) {
      recordDrop(active, 'event_limit', bytes);
      return false;
    }
    const markerReserve = Math.min(
      ROOT_MARKER_RESERVE_MAX_BYTES,
      Math.floor(limits.rootBytes / 4),
    );
    const rootCeiling = enforceContentBudget
      ? Math.max(0, limits.rootBytes - markerReserve)
      : limits.rootBytes;
    if (active.retainedBytes + bytes > rootCeiling) {
      recordDrop(active, 'root_limit', bytes);
      return false;
    }
    if (active.queuedBytes + bytes > limits.pendingQueueBytes) {
      recordDrop(active, 'pending_queue_limit', bytes);
      return false;
    }
    active.sequence += 1;
    active.retainedBytes += bytes;
    active.queuedBytes += bytes;
    active.queue.push({ message, bytes });
    schedule(active);
    return true;
  }

  function schedule(active: ActiveState): void {
    if (active.destroyed || active.drainScheduled) return;
    active.drainScheduled = true;
    scheduleDrain(() => drain(active));
  }

  function drain(active: ActiveState): void {
    if (active.destroyed) return;
    active.drainScheduled = false;
    const pending = active.queue.splice(0, 8);
    for (const item of pending) {
      active.queuedBytes -= item.bytes;
      if (!safePost(active.owner, item.message)) {
        destroy(active);
        return;
      }
    }
    if (active.queue.length > 0) {
      schedule(active);
      return;
    }
    if (active.finishedReason === null) return;

    for (const [reason, dropped] of active.droppedByReason) {
      postTerminalEvent(active, {
        kind: 'evidence_dropped',
        reason,
        droppedEventCount: dropped.count,
        droppedBytes: dropped.bytes,
      });
    }
    postTerminalEvent(active, {
      kind: 'capture_completed',
      reason: active.finishedReason,
      contentEventCount: active.contentEventCount,
      truncatedFieldCount: active.truncatedFieldCount,
      droppedEventCount: active.droppedEventCount,
      droppedBytes: active.droppedBytes,
      retainedBytes: active.retainedBytes,
    });
    active.destroyed = true;
    if (state === active) state = null;
  }

  function postTerminalEvent(active: ActiveState, event: DevRawCaptureEventData): void {
    if (active.destroyed) return;
    const message = delivery(active, event);
    const bytes = serializedBytes(message);
    if (bytes > limits.eventBytes || active.retainedBytes + bytes > limits.rootBytes) return;
    active.sequence += 1;
    active.retainedBytes += bytes;
    if (!safePost(active.owner, message)) destroy(active);
  }

  function delivery(active: ActiveState, event: DevRawCaptureEventData): DevRawCaptureEvent {
    return {
      version: 1,
      type: 'raw_capture_event',
      captureId: active.captureId,
      rootOperationId: active.rootOperationId,
      sequence: active.sequence,
      event,
    };
  }

  function eventFits(active: ActiveState, event: DevRawCaptureEventData): boolean {
    return serializedBytes(delivery(active, event)) <= limits.eventBytes;
  }

  function fitFieldToEvent(
    active: ActiveState,
    base: Omit<Extract<DevRawCaptureEventData, { kind: DevRawCaptureContentKind }>, 'content'>,
    field: RawCaptureField,
  ): RawCaptureField {
    const event = { ...base, content: field } as DevRawCaptureEventData;
    const overflow = serializedBytes(delivery(active, event)) - limits.eventBytes;
    if (overflow <= 0) return field;
    const text = truncateUtf8(field.text, Math.max(0, field.retainedBytes - overflow - 16));
    return Object.freeze({
      ...field,
      text,
      retainedBytes: utf8Bytes(text),
      truncated: true,
    });
  }

  return Object.freeze({ arm, disarm, disconnect, beginRoot });
}

function recordDrop(active: ActiveState, reason: DropReason, bytes: number): void {
  active.droppedEventCount += 1;
  active.droppedBytes += bytes;
  const current = active.droppedByReason.get(reason) ?? { count: 0, bytes: 0 };
  active.droppedByReason.set(reason, {
    count: current.count + 1,
    bytes: current.bytes + bytes,
  });
}

function scrubCoordinate(
  value: string | undefined,
  configuredSecrets: readonly string[],
): Readonly<{ text: string | null; truncated: boolean }> {
  if (value === undefined) return { text: null, truncated: false };
  const scrubbed = scrubRawCaptureText(value, configuredSecrets).text;
  const text = truncateUtf8(scrubbed, RAW_CAPTURE_COORDINATE_MAX_BYTES);
  return { text, truncated: text !== scrubbed };
}

function normalizeLimits(input: Partial<CaptureLimits> | undefined): CaptureLimits {
  return {
    fieldBytes: validLimit(input?.fieldBytes, RAW_CAPTURE_FIELD_MAX_BYTES),
    eventBytes: validLimit(input?.eventBytes, RAW_CAPTURE_EVENT_MAX_BYTES),
    rootBytes: validLimit(input?.rootBytes, RAW_CAPTURE_ROOT_MAX_BYTES),
    pendingQueueBytes: validLimit(
      input?.pendingQueueBytes,
      RAW_CAPTURE_PENDING_QUEUE_MAX_BYTES,
    ),
  };
}

function validLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError('Raw capture limit is invalid.');
  }
  return value;
}

function serializedBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

function safePost(port: DevRawCapturePort, message: DevRawCaptureEvent): boolean {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function defaultRandomId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
