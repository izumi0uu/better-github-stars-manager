import assert from 'node:assert/strict';

const DEFAULT_PROVIDER_ORIGIN = 'https://api.openai.com';
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const MAX_CAPTURE_RECORDS = 128;
const MAX_INPUT_ITEMS = 128;
const MAX_TOOL_NAMES = 32;
const MAX_LABEL_LENGTH = 160;
const MAX_HELD_RESPONSES = 2;
const MAX_OPAQUE_LENGTH = 2_048;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:/-]+$/;
const CONTROL_CAPTURES = new WeakMap();
const CONTROLLED_PROVIDER_CLIENTS = new WeakMap();

/**
 * Installs one fail-closed CDP Fetch gate for the representative Responses API.
 * Request bodies are parsed only long enough to drive the local script; captures
 * retain structural facts and byte counts, never prompt, credential, artifact, or
 * cursor values.
 */
export function createControlledResponsesProvider({
  handler,
  providerOrigin = DEFAULT_PROVIDER_ORIGIN,
  httpFixtureHandler = null,
} = {}) {
  if (typeof handler !== 'function') {
    throw new TypeError('Controlled Responses provider requires a request handler.');
  }

  const captureRecords = [];
  const httpFixtureRecords = [];
  const interruptionRecords = [];
  const control = {
    providerOrigin: normalizeProviderOrigin(providerOrigin),
    requestHandler: handler,
    httpFixtureHandler: typeof httpFixtureHandler === 'function' ? httpFixtureHandler : null,
    capture: appendOnlyView(captureRecords),
    httpFixtureCapture: appendOnlyView(httpFixtureRecords),
    interruptions: appendOnlyView(interruptionRecords),
    failures: [],
    unexpectedRequests: [],
    overflow: {
      capture: false,
      httpFixture: false,
      unexpected: false,
      interruptions: false,
      failures: false,
      offeredTools: false,
      priorTools: false,
      inputItems: false,
      toolResults: false,
    },
    pendingInterceptions: new Set(),
    liveInterceptions: new Set(),
    heldInterceptions: new Map(),
    clientStates: new Set(),
    closed: false,
    closing: false,
  };

  CONTROL_CAPTURES.set(control, { captureRecords, httpFixtureRecords, interruptionRecords });
  control.hasHeldResponse = (label) => control.heldInterceptions.has(normalizeHoldLabel(label));
  control.releaseHeldResponse = (label) => releaseHeldResponse(control, label);
  return control;
}

/** Install the initial service-worker CDP Fetch gate. */
export async function installControlledProvider(target, control) {
  if (!target || typeof target.createCDPSession !== 'function') {
    throw new TypeError('Controlled provider target must create a CDP session.');
  }
  return installControlledProviderClient(await target.createCDPSession(), control);
}

/** Install an additional fail-closed gate before a replacement worker runs. */
export async function installControlledProviderClient(client, control) {
  if (
    !client
    || typeof client.send !== 'function'
    || typeof client.on !== 'function'
    || typeof client.detach !== 'function'
  ) {
    throw new TypeError('Controlled provider client must be a CDP session.');
  }
  if (!control || typeof control !== 'object' || typeof control.requestHandler !== 'function') {
    throw new TypeError('Controlled provider control is invalid.');
  }
  if (control.closed || control.closing) throw new Error('Controlled provider is already closing or closed.');
  const handle = Object.freeze({});
  const clientState = {
    client,
    onRequestPaused: null,
    fetchEnabled: false,
    networkEnabled: false,
    detached: false,
    retired: false,
  };
  CONTROLLED_PROVIDER_CLIENTS.set(handle, clientState);
  control.clientStates.add(clientState);

  let setupStep = 'Network.enable';
  try {
    await client.send('Network.enable');
    clientState.networkEnabled = true;
    installRequestPausedListener(clientState, control);
    setupStep = 'Fetch.enable';
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    clientState.fetchEnabled = true;
    return handle;
  } catch (error) {
    const rollbackFailures = await cleanupControlledProviderClient(clientState);
    if (rollbackFailures.length === 0) {
      clientState.retired = true;
      throw error;
    }
    throw new Error(
      `Controlled provider setup failed during ${setupStep}; rollback failed: ${rollbackFailures.slice(0, 8).join(',')}.`,
      { cause: error },
    );
  }
}
function installRequestPausedListener(clientState, control) {
  const { client } = clientState;
  const onRequestPaused = (event) => {
    const rawUrl = typeof event.request?.url === 'string' ? event.request.url : '';
    if (!isHttpUrl(rawUrl)) {
      void client.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {
        appendFailure(control, 'non-http-continue-failed');
      });
      return;
    }
    const requestId = boundedIdentifier(event.requestId);
    if (!requestId) {
      appendFailure(control, 'invalid-request-id');
      void client.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }).catch(() => {
        appendFailure(control, 'fail-closed-cleanup-failed');
      });
      return;
    }
    const method = normalizeHttpMethod(event.request?.method);
    const record = {
      requestId,
      route: classifyHttpRoute(control, rawUrl),
      method,
      kind: 'pending',
      state: 'paused',
      clientState,
    };
    const resourceType = normalizeResourceType(event.resourceType);
    const authorizationPresent = hasAuthorization(event.request?.headers);
    const postData = event.request?.postData ?? '{}';
    control.liveInterceptions.add(record);
    trackInterception(
      control,
      client,
      record,
      () => handlePausedRequest(control, client, requestId, rawUrl, method, postData, authorizationPresent, resourceType, record),
    );
  };
  clientState.onRequestPaused = onRequestPaused;
  client.on('Fetch.requestPaused', onRequestPaused);
}

/** Retire only the stopped client's unresolved work without replaying it. */
export async function retireControlledProviderClient(control, handle) {
  const clientState = CONTROLLED_PROVIDER_CLIENTS.get(handle);
  if (!clientState || !control?.clientStates?.has(clientState) || clientState.retired) return false;
  interruptControlledProviderClient(control, clientState);
  const cleanupFailures = await cleanupControlledProviderClient(clientState);
  if (cleanupFailures.length > 0) {
    throw new Error(`Controlled provider client retirement failed: ${cleanupFailures.slice(0, 8).join(',')}.`);
  }
  clientState.retired = true;
  return true;
}
/** Enable Runtime while the initial worker is running, before any stopped-target handoff. */
export async function enableControlledProviderRuntime(control, handle) {
  const clientState = CONTROLLED_PROVIDER_CLIENTS.get(handle);
  if (!clientState || !control?.clientStates?.has(clientState) || clientState.retired) {
    throw new Error('Controlled provider client is unavailable for Runtime instrumentation.');
  }
  await clientState.client.send('Runtime.enable');
}

/** Transfer an already-armed gate to a new handle without issuing CDP commands. */
export function handoffStoppedControlledProviderClient(control, handle) {
  const clientState = CONTROLLED_PROVIDER_CLIENTS.get(handle);
  if (!clientState || !control?.clientStates?.has(clientState) || clientState.retired) {
    throw new Error('Controlled provider stopped client is unavailable for handoff.');
  }
  interruptControlledProviderClient(control, clientState);
  const listenerFailures = [];
  removeClientStateListener(clientState, 'Fetch.requestPaused', 'onRequestPaused', listenerFailures);
  if (listenerFailures.length > 0) {
    throw new Error(`Controlled provider stopped client handoff failed: ${listenerFailures.join(',')}.`);
  }
  const replacementState = {
    client: clientState.client,
    onRequestPaused: null,
    fetchEnabled: clientState.fetchEnabled,
    networkEnabled: clientState.networkEnabled,
    detached: false,
    retired: false,
  };
  clientState.fetchEnabled = false;
  clientState.networkEnabled = false;
  clientState.detached = true;
  clientState.retired = true;
  const installedClient = Object.freeze({});
  CONTROLLED_PROVIDER_CLIENTS.set(installedClient, replacementState);
  control.clientStates.add(replacementState);
  installRequestPausedListener(replacementState, control);
  return Object.freeze({
    client: replacementState.client,
    installedClient,
    attachmentId: boundedIdentifier(replacementState.client.id?.()) ?? 'retained-cdp-session',
  });
}

function interruptControlledProviderClient(control, clientState) {
  for (const [label, held] of control.heldInterceptions) {
    if (held.record.clientState !== clientState) continue;
    control.heldInterceptions.delete(label);
    interruptInterception(control, held.record);
  }
  for (const record of [...control.liveInterceptions]) {
    if (record.clientState === clientState) interruptInterception(control, record);
  }
}

async function cleanupControlledProviderClient(clientState, { detach = true } = {}) {
  const outcomes = [];
  const attempt = async (step, operation, settle) => {
    try {
      await operation();
      settle();
    } catch (error) {
      outcomes.push({ step, error, settle });
    }
  };

  if (clientState.fetchEnabled) {
    await attempt('fetch-disable', () => clientState.client.send('Fetch.disable'), () => {
      clientState.fetchEnabled = false;
    });
  }
  if (clientState.networkEnabled) {
    await attempt('network-disable', () => clientState.client.send('Network.disable'), () => {
      clientState.networkEnabled = false;
    });
  }
  if (detach && !clientState.detached) {
    await attempt('detach', () => clientState.client.detach(), () => {
      clientState.detached = true;
    });
  }

  const detachedEvidence = clientState.client.detached === true;
  const failures = [];
  for (const outcome of outcomes) {
    if (detachedEvidence && isAlreadyDetachedOutcome(outcome.error)) {
      outcome.settle();
    } else {
      failures.push(outcome.step);
    }
  }

  if (clientState.detached || detachedEvidence || !clientState.fetchEnabled) {
    removeClientStateListener(clientState, 'Fetch.requestPaused', 'onRequestPaused', failures);
  }
  return [...new Set(failures)];
}

function removeClientStateListener(clientState, event, field, failures) {
  const listener = clientState[field];
  if (!listener) return;
  try {
    if (typeof clientState.client.off === 'function') clientState.client.off(event, listener);
    else if (typeof clientState.client.removeListener === 'function') clientState.client.removeListener(event, listener);
    else throw new Error('CDP client cannot remove listeners.');
    clientState[field] = null;
  } catch {
    failures.push('remove-request-listener');
  }
}

function isAlreadyDetachedOutcome(error) {
  if (!(error instanceof Error)) return false;
  return /(?:^|: )(?:Session closed\. Most likely the [A-Za-z0-9_-]+ has been closed\.|Session already detached\. Most likely the [A-Za-z0-9_-]+ has been closed\.|Target closed\.?|Session with given id not found\.)$/.test(error.message);
}

async function handlePausedRequest(
  control,
  client,
  requestId,
  rawUrl,
  method,
  postData,
  authorizationPresent,
  resourceType,
  record,
) {
  if (!isResponsesUrl(control, rawUrl)) {
    await handleHttpFixtureRequest(control, client, requestId, resourceType, record);
    return;
  }
  if (method !== 'POST') {
    appendUnexpectedRequest(control, record, 'unexpected-provider-method');
    await failClosed(control, client, requestId, record, 'unexpected-provider-method');
    return;
  }

  let body;
  try {
    body = JSON.parse(postData);
  } catch {
    appendFailure(control, 'invalid-responses-json');
    await failClosed(control, client, requestId, record, 'invalid-responses-json');
    return;
  }

  const request = normalizeResponsesRequest(body, control);
  const outcome = await control.requestHandler(request);
  const normalizedOutcome = normalizeOutcome(outcome);
  record.kind = normalizedOutcome.kind;
  appendProviderCapture(control, request, normalizedOutcome, authorizationPresent, record);

  const fulfill = createResponseFulfill(control, client, requestId, record, normalizedOutcome);
  if (normalizedOutcome.hold !== null) {
    holdResponse(control, record, normalizedOutcome.hold, fulfill);
    return;
  }
  await fulfill();
}

async function handleHttpFixtureRequest(control, client, requestId, resourceType, record) {
  const request = Object.freeze({
    route: record.route,
    method: record.method,
    resourceType,
  });
  const outcome = control.httpFixtureHandler ? await control.httpFixtureHandler(request) : null;
  if (!outcome) {
    appendUnexpectedRequest(control, record, 'unexpected-http-request');
    await failClosed(control, client, requestId, record, 'unexpected-http-request');
    return;
  }

  const response = normalizeHttpFixtureResponse(outcome);
  record.kind = boundedIdentifier(outcome.kind) ?? 'http-fixture';
  appendHttpFixtureCapture(control, request, response.status, record.kind);
  await fulfillInterceptedRequest(control, client, requestId, record, response);
}

function trackInterception(control, client, record, operation) {
  let tracked;
  tracked = Promise.resolve()
    .then(operation)
    .catch(async () => {
      if (record.state === 'interrupted') return;
      appendFailure(control, 'interception-handler-failed');
      await failClosed(control, client, record.requestId, record, 'interception-handler-failed');
    })
    .finally(() => control.pendingInterceptions.delete(tracked));
  control.pendingInterceptions.add(tracked);
  return tracked;
}

function normalizeOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new TypeError('Controlled Responses handler must return an outcome object.');
  }
  if (!outcome.completion || typeof outcome.completion !== 'object' || Array.isArray(outcome.completion)) {
    throw new TypeError('Controlled Responses outcome must include a completion.');
  }
  const hold = outcome.hold === undefined || outcome.hold === false
    ? null
    : normalizeHoldLabel(outcome.hold === true ? 'checkpoint' : outcome.hold);
  return {
    kind: boundedIdentifier(outcome.kind) ?? 'responses',
    completion: outcome.completion,
    hold,
    httpStatus: normalizeStatus(outcome.httpStatus),
  };
}

function createResponseFulfill(control, client, requestId, record, outcome) {
  return () => fulfillResponsesRequest(control, client, requestId, record, outcome);
}

async function fulfillResponsesRequest(control, client, requestId, record, outcome) {
  const response = outcome.httpStatus === 200
    ? {
      status: 200,
      responseHeaders: [{ name: 'content-type', value: 'text/event-stream' }],
      body: buildResponsesSse(outcome.completion, control.capture.length),
    }
    : {
      status: outcome.httpStatus,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: JSON.stringify({ error: { type: 'controlled_provider_error', code: 'controlled_provider_http_error' } }),
    };
  await fulfillInterceptedRequest(control, client, requestId, record, response);
}

async function fulfillInterceptedRequest(control, client, requestId, record, response) {
  assert.equal(record.state, 'paused', 'Controlled interception was not paused before fulfillment.');
  await client.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: response.status,
    responseHeaders: response.responseHeaders,
    body: Buffer.from(response.body).toString('base64'),
  });
  settleInterception(control, record, 'fulfilled');
}

async function failClosed(control, client, requestId, record, reason) {
  if (record.state !== 'paused') return;
  record.kind = boundedIdentifier(reason) ?? 'failed-closed';
  try {
    await client.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
  } catch {
    appendFailure(control, 'fail-closed-cleanup-failed');
  } finally {
    settleInterception(control, record, 'failed-closed');
  }
}

function holdResponse(control, record, label, fulfill) {
  if (control.heldInterceptions.size >= MAX_HELD_RESPONSES) {
    throw new Error('Controlled provider exceeded the bounded response-hold limit.');
  }
  if (control.heldInterceptions.has(label)) {
    throw new Error('Controlled provider received a duplicate response-hold label.');
  }
  record.state = 'held';
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    control.heldInterceptions.delete(label);
    record.state = 'paused';
    return trackInterception(control, record.clientState.client, record, fulfill);
  };
  control.heldInterceptions.set(label, { release, record });
}

async function releaseHeldResponse(control, label) {
  const normalized = normalizeHoldLabel(label);
  const held = control.heldInterceptions.get(normalized);
  if (!held) throw new Error('Controlled provider hold was not available.');
  await held.release();
}

function settleInterception(control, record, state) {
  record.state = state;
  control.liveInterceptions.delete(record);
}
function interruptInterception(control, record) {
  if (record.state === 'interrupted' || record.state === 'fulfilled' || record.state === 'failed-closed') return;
  record.state = 'interrupted';
  control.liveInterceptions.delete(record);
  const captures = CONTROL_CAPTURES.get(control);
  appendBoundedRecord(
    captures?.interruptionRecords,
    Object.freeze({ route: record.route, method: record.method, kind: record.kind }),
    control,
    'interruptions',
  );
}


/** Assert that every intercepted request was settled and none escaped the local gate. */
export async function assertControlledProviderHealthy(control, { timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS } = {}) {
  if (!control) return;
  await waitForPendingInterceptions(control, timeoutMs);
  const unresolved = control.liveInterceptions.size + control.heldInterceptions.size;
  if (unresolved > 0) throw new Error('Controlled provider left intercepted requests unresolved.');
  if (control.failures.length > 0) throw new Error('Controlled provider interception health failed.');
  if (control.unexpectedRequests.length > 0) throw new Error('Controlled provider observed unexpected HTTP(S) traffic.');
  if (hasCaptureOverflow(control)) throw new Error('Controlled provider capture exceeded bounded limits.');
}

/** Fail retained work and detach every active CDP gate before browser shutdown. */
export async function closeControlledResponsesProvider(control, { timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS } = {}) {
  if (!control || control.closed) return;
  if (control.closing) throw new Error('Controlled provider close is already in progress.');
  assertTimeout(timeoutMs, 'timeoutMs');
  control.closing = true;
  const baseline = snapshotControlHealth(control);
  const closeFailures = [];
  const attempt = async (step, operation) => {
    try {
      await operation();
    } catch {
      closeFailures.push(step);
    }
  };

  try {
    await attempt('drain-pending', () => waitForPendingInterceptions(control, timeoutMs));
    await attempt('fail-live', () => failLiveInterceptions(control));
    await attempt('final-drain', () => waitForPendingInterceptions(control, timeoutMs));

    let clientIndex = 0;
    for (const clientState of control.clientStates) {
      const currentIndex = clientIndex;
      clientIndex += 1;
      if (clientState.retired) continue;
      const cleanupFailures = await cleanupControlledProviderClient(clientState);
      if (cleanupFailures.length === 0) {
        clientState.retired = true;
      } else {
        for (const failure of cleanupFailures) closeFailures.push(`client-${currentIndex}-${failure}`);
      }
    }

    await attempt('post-cleanup-fail-live', () => failLiveInterceptions(control));
    await attempt('post-cleanup-drain', () => waitForPendingInterceptions(control, timeoutMs));
    if (control.liveInterceptions.size > 0 || control.heldInterceptions.size > 0 || control.pendingInterceptions.size > 0) {
      closeFailures.push('unresolved-work');
    }
    if ([...control.clientStates].some((clientState) => !clientState.retired)) {
      closeFailures.push('unretired-client');
    }
    if (controlHealthChanged(control, baseline)) closeFailures.push('control-health-changed');
    if (closeFailures.length > 0) {
      throw new Error(`Controlled provider close did not settle the CDP gates: ${closeFailures.slice(0, 8).join(',')}.`);
    }
    control.closed = true;
  } finally {
    control.closing = false;
  }
}

function snapshotControlHealth(control) {
  return {
    failureCount: control.failures.length,
    unexpectedCount: control.unexpectedRequests.length,
    overflowKeys: new Set(Object.entries(control.overflow ?? {}).filter(([, value]) => value === true).map(([key]) => key)),
  };
}

function controlHealthChanged(control, baseline) {
  if (control.failures.length !== baseline.failureCount) return true;
  if (control.unexpectedRequests.length !== baseline.unexpectedCount) return true;
  return Object.entries(control.overflow ?? {}).some(([key, value]) => value === true && !baseline.overflowKeys.has(key));
}

function hasCaptureOverflow(control) {
  return Object.values(control.overflow ?? {}).some(Boolean);
}

async function failLiveInterceptions(control) {
  for (const [label, held] of control.heldInterceptions) {
    control.heldInterceptions.delete(label);
    held.record.state = 'paused';
  }
  await Promise.all([...control.liveInterceptions].map(async (record) => {
    if (record.state === 'paused') {
      await failClosed(
        control,
        record.clientState.client,
        record.requestId,
        record,
        'teardown-live-request',
      );
    }
  }));
}

async function waitForPendingInterceptions(control, timeoutMs) {
  assertTimeout(timeoutMs, 'timeoutMs');
  const deadline = Date.now() + timeoutMs;
  while (control.pendingInterceptions.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Controlled provider pending interception did not settle before deadline.');
    await settleBeforeDeadline(Promise.allSettled([...control.pendingInterceptions]), remaining);
  }
}

function settleBeforeDeadline(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Controlled provider pending interception did not settle before deadline.')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function assertTimeout(value, field) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be a positive number.`);
}

function normalizeResponsesRequest(body, control) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const toolCalls = [];
  let toolCallCount = 0;
  for (const entry of input) {
    if (entry?.type !== 'function_call') continue;
    toolCallCount += 1;
    appendBoundedTail(toolCalls, Object.freeze({
      id: boundedOpaque(entry.call_id ?? entry.id),
      name: boundedIdentifier(entry.name),
      arguments: parseObject(entry.arguments),
    }), MAX_TOOL_NAMES);
  }
  if (toolCallCount > MAX_TOOL_NAMES) control.overflow.priorTools = true;
  const callNames = new Map(toolCalls.filter((call) => call.id && call.name).map((call) => [call.id, call.name]));
  const toolResults = [];
  let toolResultCount = 0;
  for (const entry of input) {
    if (entry?.type !== 'function_call_output') continue;
    toolResultCount += 1;
    appendBoundedTail(toolResults, normalizeToolResult(entry, callNames), MAX_TOOL_NAMES);
  }
  if (toolResultCount > MAX_TOOL_NAMES) control.overflow.toolResults = true;
  const offeredTools = Array.isArray(body?.tools) ? body.tools : [];
  const offeredToolNames = [];
  for (const tool of offeredTools) {
    if (offeredToolNames.length >= MAX_TOOL_NAMES) continue;
    const name = boundedIdentifier(tool?.name);
    if (name) offeredToolNames.push(name);
  }
  if (offeredTools.length > MAX_TOOL_NAMES) control.overflow.offeredTools = true;
  if (input.length > MAX_INPUT_ITEMS) control.overflow.inputItems = true;
  const selectedTool = body?.tool_choice?.type === 'function'
    ? boundedIdentifier(body.tool_choice.name)
    : null;
  return Object.freeze({
    protocol: 'responses',
    route: 'responses',
    model: boundedIdentifier(body?.model),
    toolName: selectedTool,
    offeredToolNames: Object.freeze(offeredToolNames),
    priorToolNames: Object.freeze(toolCalls.map((call) => call.name).filter(Boolean)),
    latestToolCall: toolCalls.at(-1) ?? null,
    latestToolResult: toolResults.at(-1) ?? null,
    metrics: Object.freeze({
      inputItemCount: boundedNonnegativeInteger(input.length),
      capturedInputItemCount: boundedNonnegativeInteger(Math.min(input.length, MAX_INPUT_ITEMS)),
      toolCallCount: boundedNonnegativeInteger(toolCallCount),
      toolResultCount: boundedNonnegativeInteger(toolResultCount),
      offeredToolCount: boundedNonnegativeInteger(offeredTools.length),
    }),
  });
}

function appendBoundedTail(target, item, limit) {
  if (target.length >= limit) target.shift();
  target.push(item);
}

function normalizeToolResult(entry, callNames) {
  const callId = boundedOpaque(entry.call_id);
  const envelope = parseObject(entry.output);
  const payload = envelope?.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
    ? envelope.data
    : envelope;
  return Object.freeze({
    callId,
    name: boundedIdentifier(entry.name ?? callNames.get(callId)),
    status: boundedIdentifier(payload?.status),
    artifactId: boundedOpaque(payload?.artifactId),
    nextCursor: payload?.nextCursor === null ? null : boundedOpaque(payload?.nextCursor),
    matchByteOffset: boundedNonnegativeInteger(payload?.matchByteOffset),
    byteLength: boundedNonnegativeInteger(payload?.byteLength),
    totalBytes: boundedNonnegativeInteger(payload?.totalBytes),
  });
}


function appendProviderCapture(control, request, outcome, authorizationPresent, record) {
  const records = CONTROL_CAPTURES.get(control)?.captureRecords;
  if (!records) return;
  if (records.length >= MAX_CAPTURE_RECORDS) {
    control.overflow.capture = true;
    return;
  }
  records.push(Object.freeze({
    ordinal: records.length + 1,
    kind: outcome.kind,
    route: record.route,
    protocol: 'responses',
    model: request.model,
    authorizationPresent,
    httpStatus: outcome.httpStatus,
    held: outcome.hold !== null,
    toolNames: Object.freeze({
      selected: request.toolName,
      offered: Object.freeze([...request.offeredToolNames]),
      prior: Object.freeze([...request.priorToolNames]),
    }),
    latestToolResult: semanticToolResult(request.latestToolResult),
    metrics: request.metrics,
  }));
}

function appendHttpFixtureCapture(control, request, status, kind) {
  const records = CONTROL_CAPTURES.get(control)?.httpFixtureRecords;
  if (!records) return;
  if (records.length >= MAX_CAPTURE_RECORDS) {
    control.overflow.httpFixture = true;
    return;
  }
  records.push(Object.freeze({
    ordinal: records.length + 1,
    kind: boundedIdentifier(kind) ?? 'http-fixture',
    route: request.route,
    method: request.method,
    status,
    resourceType: request.resourceType,
  }));
}
function appendBoundedRecord(records, record, control, overflowKey) {
  if (!records) return;
  if (records.length >= MAX_CAPTURE_RECORDS) {
    control.overflow[overflowKey] = true;
    return;
  }
  records.push(record);
}


function semanticToolResult(result) {
  if (!result) return null;
  return Object.freeze({
    name: result.name,
    status: result.status,
    hasArtifact: result.artifactId !== null,
    hasNextCursor: result.nextCursor !== null,
    hasMatchByteOffset: result.matchByteOffset !== null,
    byteLength: result.byteLength,
    totalBytes: result.totalBytes,
  });
}

function appendUnexpectedRequest(control, record, kind) {
  appendFailure(control, kind);
  if (control.unexpectedRequests.length >= MAX_CAPTURE_RECORDS) {
    control.overflow.unexpected = true;
    return;
  }
  control.unexpectedRequests.push(Object.freeze({
    kind: boundedIdentifier(kind) ?? 'unexpected-http-request',
    method: record.method,
    route: record.route,
  }));
}

function appendFailure(control, code) {
  const normalized = boundedIdentifier(code) ?? 'controlled-provider-failure';
  if (control.failures.length >= MAX_CAPTURE_RECORDS) {
    control.overflow.failures = true;
    return;
  }
  control.failures.push(normalized);
}

export function buildResponsesSse(completion, sequence) {
  const responseId = `resp_runtime_${sequence}`;
  const events = [{ type: 'response.created', response: { id: responseId, status: 'in_progress' } }];
  if (completion.toolCall) {
    const call = completion.toolCall;
    const itemId = `fc_runtime_${sequence}`;
    events.push(
      { type: 'response.output_item.added', response_id: responseId, output_index: 0, item: { id: itemId, type: 'function_call', call_id: call.id, name: call.name, arguments: '' } },
      { type: 'response.function_call_arguments.delta', response_id: responseId, item_id: itemId, output_index: 0, delta: call.arguments },
      { type: 'response.function_call_arguments.done', response_id: responseId, item_id: itemId, output_index: 0, arguments: call.arguments },
      { type: 'response.output_item.done', response_id: responseId, output_index: 0, item: { id: itemId, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: call.arguments } },
    );
  } else {
    const itemId = `msg_runtime_${sequence}`;
    const content = typeof completion.content === 'string' ? completion.content : '';
    events.push(
      { type: 'response.output_item.added', response_id: responseId, output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta: content },
      { type: 'response.output_text.done', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, text: content },
      { type: 'response.content_part.done', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: content, annotations: [] } },
      { type: 'response.output_item.done', response_id: responseId, output_index: 0, item: { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: content, annotations: [] }] } },
    );
  }
  events.push({ type: 'response.completed', response: { id: responseId, status: 'completed', usage: normalizeUsage(completion.usage) } });
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function normalizeUsage(usage) {
  const inputTokens = boundedNonnegativeInteger(usage?.input_tokens) ?? 10;
  const outputTokens = boundedNonnegativeInteger(usage?.output_tokens) ?? 10;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: boundedNonnegativeInteger(usage?.total_tokens) ?? inputTokens + outputTokens,
  };
}

function normalizeHttpFixtureResponse(outcome) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new TypeError('HTTP fixture must return a response object.');
  }
  const status = boundedNonnegativeInteger(outcome.status);
  if (status === null || status < 100 || status > 599) {
    throw new RangeError('HTTP fixture status must be between 100 and 599.');
  }
  if (typeof outcome.body !== 'string') throw new TypeError('HTTP fixture body must be a string.');
  const responseHeaders = [];
  if (outcome.contentType !== undefined) responseHeaders.push(normalizeHeader('content-type', outcome.contentType));
  if (outcome.headers !== undefined) {
    if (!outcome.headers || typeof outcome.headers !== 'object' || Array.isArray(outcome.headers)) {
      throw new TypeError('HTTP fixture headers must be an object.');
    }
    for (const [name, value] of Object.entries(outcome.headers)) responseHeaders.push(normalizeHeader(name, value));
  }
  return { status, responseHeaders, body: outcome.body };
}

function normalizeHeader(name, value) {
  if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new TypeError('HTTP fixture header name is invalid.');
  }
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    throw new TypeError('HTTP fixture header value is invalid.');
  }
  return { name, value };
}

function isResponsesUrl(control, value) {
  return value === `${control.providerOrigin}/v1/responses`;
}

function normalizeProviderOrigin(value) {
  const url = new URL(String(value));
  if (!/^https?:$/.test(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Controlled provider origin must be an HTTP(S) origin without a path.');
  }
  return url.origin;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function normalizeHttpMethod(value) {
  const method = typeof value === 'string' ? value.toUpperCase() : '';
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'UNKNOWN';
}

function normalizeResourceType(value) {
  return ['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'XHR', 'Fetch', 'EventSource', 'Preflight', 'Other'].includes(value) ? value : 'Other';
}

function normalizeStatus(value) {
  if (value === undefined || value === null) return 200;
  const status = boundedNonnegativeInteger(value);
  if (status === null || (status !== 200 && (status < 400 || status > 599))) {
    throw new RangeError('Controlled Responses status must be 200 or an HTTP error status.');
  }
  return status;
}

function normalizeHoldLabel(value) {
  const label = String(value ?? '');
  if (!/^[a-z0-9-]{1,64}$/.test(label)) {
    throw new TypeError('Controlled response-hold label is invalid.');
  }
  return label;
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasAuthorization(headers = {}) {
  return Object.keys(headers).some((name) => name.toLowerCase() === 'authorization');
}


function boundedIdentifier(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= MAX_LABEL_LENGTH && SAFE_IDENTIFIER.test(text) ? text : null;
}

function boundedOpaque(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 0 && text.length <= MAX_OPAQUE_LENGTH ? text : null;
}

function boundedNonnegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function classifyHttpRoute(control, value) {
  if (isResponsesUrl(control, value)) return 'responses';
  try {
    const url = new URL(String(value));
    if (url.origin !== 'https://api.github.com') return 'unknown-http-route';
    if (url.pathname === '/user') return 'github-user';
    if (/^\/repos\/[^/]+\/[^/]+$/u.test(url.pathname)) return 'github-repository';
    if (/^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/.+$/u.test(url.pathname)) return 'github-branch-ref';
    if (/^\/repos\/[^/]+\/[^/]+\/contents$/u.test(url.pathname)) return 'github-contents';
    if (/^\/repos\/[^/]+\/[^/]+\/contents\/.+$/u.test(url.pathname)) return 'github-contents-file';
    if (url.pathname === '/user/starred') return 'github-starred';
    if (/^\/users\/[^/]+\/repos$/u.test(url.pathname)) return 'github-owned-repos';
    if (url.pathname === '/search/repositories') return 'github-repository-search';
    if (url.pathname === '/user/subscriptions') return 'github-watch-scope';
    if (url.pathname === '/notifications') return 'github-notifications';
    if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/u.test(url.pathname)) return 'github-watch-subject';
    if (url.pathname === '/gists') return 'github-gists';
    if (url.pathname === '/gists/runtime-probe-gist') return 'github-probe-gist';
  } catch {
    return 'unknown-http-route';
  }
  return 'unknown-http-route';
}


function appendOnlyView(records) {
  return new Proxy(records, {
    set() { return false; },
    deleteProperty() { return false; },
    defineProperty() { return false; },
  });
}
