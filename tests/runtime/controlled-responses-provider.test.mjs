import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  assertControlledProviderHealthy,
  closeControlledResponsesProvider,
  createControlledResponsesProvider,
  enableControlledProviderRuntime,
  handoffStoppedControlledProviderClient,
  installControlledProviderClient,
  retireControlledProviderClient,
} from './controlled-responses-provider.mjs';

class FakeCdpClient {
  constructor(label, { sendFailures = {}, detachFailures = [] } = {}) {
    this.label = label;
    this.calls = [];
    this.listeners = new Map();
    this.detached = false;
    this.sendFailures = new Map(Object.entries(sendFailures).map(([method, failures]) => [
      method,
      [...(Array.isArray(failures) ? failures : [failures])],
    ]));
    this.detachFailures = [...detachFailures];
  }

  async send(method, params = undefined) {
    this.calls.push({ method, params });
    const failure = this.sendFailures.get(method)?.shift();
    if (failure) throw failure instanceof Error ? failure : new Error(failure);
    return {};
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  off(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
  }

  emit(event, value) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  listenerCount(event) {
    return this.listeners.get(event)?.length ?? 0;
  }

  async detach() {
    this.calls.push({ method: 'CDPSession.detach', params: undefined });
    const failure = this.detachFailures.shift();
    if (failure) throw failure instanceof Error ? failure : new Error(failure);
    this.detached = true;
    this.emit('disconnected');
  }
}

describe('controlled Responses provider CDP lifecycle', () => {
  it('rolls back every installed part when Network or Fetch setup fails', async () => {
    const networkControl = createControlledResponsesProvider({ handler: async () => ({ completion: {} }) });
    const networkClient = new FakeCdpClient('network-setup-failure', {
      sendFailures: { 'Network.enable': 'network setup exploded' },
    });
    await assert.rejects(
      installControlledProviderClient(networkClient, networkControl),
      /network setup exploded/,
    );
    assert.deepEqual(networkClient.calls.map(({ method }) => method), [
      'Network.enable',
      'CDPSession.detach',
    ]);
    assert.equal(networkClient.detached, true);
    assert.equal(networkClient.listenerCount('Fetch.requestPaused'), 0);
    assert.equal(networkClient.listenerCount('disconnected'), 0);
    assert.equal([...networkControl.clientStates].every(({ retired }) => retired), true);
    await assertControlledProviderHealthy(networkControl);
    await closeControlledResponsesProvider(networkControl);

    const fetchControl = createControlledResponsesProvider({ handler: async () => ({ completion: {} }) });
    const fetchClient = new FakeCdpClient('fetch-setup-failure', {
      sendFailures: { 'Fetch.enable': 'fetch setup exploded' },
    });
    await assert.rejects(
      installControlledProviderClient(fetchClient, fetchControl),
      /fetch setup exploded/,
    );
    assert.deepEqual(fetchClient.calls.map(({ method }) => method), [
      'Network.enable',
      'Fetch.enable',
      'Network.disable',
      'CDPSession.detach',
    ]);
    assert.equal(fetchClient.detached, true);
    assert.equal(fetchClient.listenerCount('Fetch.requestPaused'), 0);
    assert.equal(fetchClient.listenerCount('disconnected'), 0);
    assert.equal([...fetchControl.clientStates].every(({ retired }) => retired), true);
    await assertControlledProviderHealthy(fetchControl);
    await closeControlledResponsesProvider(fetchControl);
  });

  it('reports required retirement cleanup failures and becomes idempotent only after cleanup succeeds', async () => {
    const control = createControlledResponsesProvider({ handler: async () => ({ completion: {} }) });
    const client = new FakeCdpClient('cleanup-failure', {
      sendFailures: { 'Fetch.disable': 'cleanup exploded' },
      detachFailures: ['detach exploded'],
    });
    const handle = await installControlledProviderClient(client, control);

    await assert.rejects(
      retireControlledProviderClient(control, handle),
      /client retirement failed: fetch-disable,detach/,
    );
    assert.equal(client.listenerCount('Fetch.requestPaused'), 1);
    assert.equal([...control.clientStates].every(({ retired }) => retired), false);
    assert.equal(await retireControlledProviderClient(control, handle), true);
    assert.equal(await retireControlledProviderClient(control, handle), false);
    assert.equal([...control.clientStates].every(({ retired }) => retired), true);
    await assertControlledProviderHealthy(control);
    await closeControlledResponsesProvider(control);
  });

  it('accepts already-detached protocol outcomes only after client detach evidence', async () => {
    const closedSession = 'Protocol error (Fetch.disable): Session closed. Most likely the service_worker has been closed.';
    const unevidencedControl = createControlledResponsesProvider({ handler: async () => ({ completion: {} }) });
    const unevidencedClient = new FakeCdpClient('unproven-stopped-target', {
      sendFailures: {
        'Fetch.disable': closedSession,
        'Network.disable': 'Protocol error (Network.disable): Target closed.',
      },
      detachFailures: ['Session already detached. Most likely the service_worker has been closed.'],
    });
    const unevidencedHandle = await installControlledProviderClient(unevidencedClient, unevidencedControl);
    await assert.rejects(
      retireControlledProviderClient(unevidencedControl, unevidencedHandle),
      /client retirement failed: fetch-disable,network-disable,detach/,
    );
    assert.equal(await retireControlledProviderClient(unevidencedControl, unevidencedHandle), true);
    await closeControlledResponsesProvider(unevidencedControl);

    const control = createControlledResponsesProvider({ handler: async () => ({ completion: {} }) });
    const client = new FakeCdpClient('stopped-target', {
      sendFailures: {
        'Fetch.disable': closedSession,
        'Network.disable': 'Protocol error (Network.disable): Target closed.',
      },
      detachFailures: ['Session already detached. Most likely the service_worker has been closed.'],
    });
    const handle = await installControlledProviderClient(client, control);
    client.detached = true;

    assert.equal(await retireControlledProviderClient(control, handle), true);
    assert.equal(await retireControlledProviderClient(control, handle), false);
    assert.equal(client.listenerCount('Fetch.requestPaused'), 0);
    await assertControlledProviderHealthy(control);
    await closeControlledResponsesProvider(control);
  });

  it('hands an armed stopped session to a replacement handle without CDP commands', async () => {
    const control = createControlledResponsesProvider({
      handler: async () => ({ kind: 'handoff-complete', completion: { content: 'replacement' } }),
    });
    const client = new FakeCdpClient('retained-stopped-session');
    const oldHandle = await installControlledProviderClient(client, control);
    await enableControlledProviderRuntime(control, oldHandle);
    const callsBeforeHandoff = client.calls.length;

    const replacement = handoffStoppedControlledProviderClient(control, oldHandle);
    assert.equal(client.calls.length, callsBeforeHandoff);
    assert.equal(client.listenerCount('Fetch.requestPaused'), 1);
    assert.equal(await retireControlledProviderClient(control, oldHandle), false);

    client.emit('Fetch.requestPaused', responsesRequest('request-after-handoff'));
    await waitUntil(() => client.calls.some(({ method }) => method === 'Fetch.fulfillRequest'));
    assert.equal(await retireControlledProviderClient(control, replacement.installedClient), true);
    assert.equal(client.listenerCount('Fetch.requestPaused'), 0);
    assert.deepEqual(client.calls.map(({ method }) => method), [
      'Network.enable',
      'Fetch.enable',
      'Runtime.enable',
      'Fetch.fulfillRequest',
      'Fetch.disable',
      'Network.disable',
      'CDPSession.detach',
    ]);
    await assertControlledProviderHealthy(control);
    await closeControlledResponsesProvider(control);
  });

  it('interrupts only the exact old held client and captures its replacement without fulfill or replay', async () => {
    let requestCount = 0;
    const control = createControlledResponsesProvider({
      handler: async () => {
        requestCount += 1;
        return requestCount === 1
          ? { kind: 'old-held', completion: { content: 'old' }, hold: 'old-worker-request' }
          : { kind: 'replacement-complete', completion: { content: 'replacement' } };
      },
    });
    const oldClient = new FakeCdpClient('old');
    const oldState = await installControlledProviderClient(oldClient, control);

    oldClient.emit('Fetch.requestPaused', responsesRequest('request-old'));
    await waitUntil(() => control.hasHeldResponse('old-worker-request'));
    assert.equal(oldClient.calls.some(({ method }) => method === 'Fetch.fulfillRequest'), false);
    assert.equal(oldClient.calls.some(({ method }) => method === 'Fetch.failRequest'), false);
    assert.equal(await retireControlledProviderClient(control, oldState), true);
    assert.equal(await retireControlledProviderClient(control, oldState), false);
    assert.deepEqual(control.interruptions, [{
      route: 'responses',
      method: 'POST',
      kind: 'old-held',
    }]);
    assert.equal(control.hasHeldResponse('old-worker-request'), false);
    await assert.rejects(control.releaseHeldResponse('old-worker-request'), /hold was not available/);
    assert.equal(oldClient.calls.some(({ method }) => method === 'Fetch.fulfillRequest'), false);
    assert.equal(oldClient.calls.some(({ method }) => method === 'Fetch.failRequest'), false);

    const replacementClient = new FakeCdpClient('replacement');
    await installControlledProviderClient(replacementClient, control);
    replacementClient.emit('Fetch.requestPaused', responsesRequest('request-replacement'));
    await waitUntil(() => replacementClient.calls.some(({ method }) => method === 'Fetch.fulfillRequest'));

    assert.equal(requestCount, 2);
    assert.equal(control.capture.length, 2);
    assert.deepEqual(control.capture.map(({ kind }) => kind), ['old-held', 'replacement-complete']);
    assert.equal(control.overflow.capture, false);
    assert.equal(control.overflow.interruptions, false);
    assert.equal(JSON.stringify({ capture: control.capture, interruptions: control.interruptions })
      .includes('runtime-secret'), false);
    assert.equal(oldClient.calls.some(({ method }) => method === 'Fetch.fulfillRequest'), false);
    await assertControlledProviderHealthy(control);
    await closeControlledResponsesProvider(control);
    assert.equal(replacementClient.detached, true);
    assert.equal(control.liveInterceptions.size, 0);
    assert.equal(control.heldInterceptions.size, 0);
    assert.equal(control.pendingInterceptions.size, 0);
    assert.equal([...control.clientStates].every(({ retired }) => retired), true);
  });

  it('closes every client and fails all held work with zero unresolved final health', async () => {
    let requestCount = 0;
    const control = createControlledResponsesProvider({
      handler: async () => {
        requestCount += 1;
        return {
          kind: `held-${requestCount}`,
          completion: { content: 'never delivered' },
          hold: `client-${requestCount}`,
        };
      },
    });
    const firstClient = new FakeCdpClient('first');
    const secondClient = new FakeCdpClient('second');
    await installControlledProviderClient(firstClient, control);
    await installControlledProviderClient(secondClient, control);
    firstClient.emit('Fetch.requestPaused', responsesRequest('request-first'));
    secondClient.emit('Fetch.requestPaused', responsesRequest('request-second'));
    await waitUntil(() => control.heldInterceptions.size === 2);

    await closeControlledResponsesProvider(control);

    for (const client of [firstClient, secondClient]) {
      assert.equal(client.calls.filter(({ method }) => method === 'Fetch.failRequest').length, 1);
      assert.equal(client.calls.some(({ method }) => method === 'Fetch.fulfillRequest'), false);
      assert.equal(client.detached, true);
      assert.equal(client.listenerCount('Fetch.requestPaused'), 0);
      assert.equal(client.listenerCount('disconnected'), 0);
    }
    assert.equal(control.liveInterceptions.size, 0);
    assert.equal(control.heldInterceptions.size, 0);
    assert.equal(control.pendingInterceptions.size, 0);
    assert.equal([...control.clientStates].every(({ retired }) => retired), true);
    assert.equal(control.closed, true);
    assert.equal(JSON.stringify(control.capture).includes('runtime-secret'), false);
    await assertControlledProviderHealthy(control);
  });
  it('accepts exactly 128 structural input items and fails closed at 129 without retaining input', async () => {
    for (const inputItemCount of [128, 129]) {
      const control = createControlledResponsesProvider({
        handler: async () => ({ kind: `input-${inputItemCount}`, completion: { content: 'bounded' } }),
      });
      const client = new FakeCdpClient(`input-${inputItemCount}`);
      await installControlledProviderClient(client, control);
      client.emit('Fetch.requestPaused', responsesRequestWithInput(`input-${inputItemCount}`, inputItemCount));
      await waitUntil(() => client.calls.some(({ method }) => method === 'Fetch.fulfillRequest'));

      assert.equal(control.capture.length, 1);
      assert.equal(control.capture[0].metrics.inputItemCount, inputItemCount);
      assert.equal(control.capture[0].metrics.capturedInputItemCount, Math.min(inputItemCount, 128));
      assert.equal(control.overflow.inputItems, inputItemCount === 129);
      assert.equal(JSON.stringify(control.capture).includes('private-input-canary'), false);
      if (inputItemCount === 128) {
        await assertControlledProviderHealthy(control);
      } else {
        await assert.rejects(
          assertControlledProviderHealthy(control),
          /capture exceeded bounded limits/,
        );
      }
      await closeControlledResponsesProvider(control);
    }
  });

  it('accepts explicit status 200 and rejects other non-error statuses', async () => {
    const successControl = createControlledResponsesProvider({
      handler: async () => ({
        kind: 'explicit-success',
        completion: { content: 'bounded' },
        httpStatus: 200,
      }),
    });
    const successClient = new FakeCdpClient('explicit-success');
    await installControlledProviderClient(successClient, successControl);
    successClient.emit('Fetch.requestPaused', responsesRequest('explicit-success'));
    await assertControlledProviderHealthy(successControl);
    assert.equal(successControl.capture[0].httpStatus, 200);
    assert.equal(
      successClient.calls.find(({ method }) => method === 'Fetch.fulfillRequest')?.params?.responseCode,
      200,
    );
    await closeControlledResponsesProvider(successControl);

    const invalidControl = createControlledResponsesProvider({
      handler: async () => ({
        kind: 'invalid-non-error-status',
        completion: { content: 'never delivered' },
        httpStatus: 201,
      }),
    });
    const invalidClient = new FakeCdpClient('invalid-non-error-status');
    await installControlledProviderClient(invalidClient, invalidControl);
    invalidClient.emit('Fetch.requestPaused', responsesRequest('invalid-non-error-status'));
    await assert.rejects(
      assertControlledProviderHealthy(invalidControl),
      /interception health failed/,
    );
    assert.equal(invalidClient.calls.some(({ method }) => method === 'Fetch.failRequest'), true);
    await closeControlledResponsesProvider(invalidControl);
  });


  it('classifies GitHub contents routes by exact path and method semantics', async () => {
    const fixtures = new Map([
      ['GET github-contents', {
        status: 200,
        contentType: 'application/json',
        body: '[]',
        kind: 'repository-directory',
      }],
      ['GET github-contents-file', {
        status: 206,
        contentType: 'application/json',
        body: '{"type":"file"}',
        kind: 'repository-file-read',
      }],
      ['PUT github-contents-file', {
        status: 201,
        contentType: 'application/json',
        body: '{"updated":true}',
        kind: 'repository-file-write',
      }],
      ['GET github-watch-scope', {
        status: 200,
        contentType: 'application/json',
        body: '[]',
        kind: 'watch-scope-probe',
      }],
      ['GET github-notifications', {
        status: 200,
        contentType: 'application/json',
        body: '[]',
        kind: 'watch-notifications-probe',
      }],
      ['GET github-watch-subject', {
        status: 200,
        contentType: 'application/json',
        body: '{"number":17}',
        kind: 'watch-subject-detail',
      }],
      ['GET unknown-http-route', {
        status: 404,
        contentType: 'application/json',
        body: '{}',
        kind: 'repository-empty-file-path',
      }],
    ]);
    const observedRequests = [];
    const control = createControlledResponsesProvider({
      handler: async () => ({ completion: {} }),
      httpFixtureHandler: (request) => {
        const key = `${request.method} ${request.route}`;
        observedRequests.push(key);
        return fixtures.get(key) ?? null;
      },
    });
    const client = new FakeCdpClient('route-classification');
    await installControlledProviderClient(client, control);

    for (const request of [
      httpRequest('file-write', 'https://api.github.com/repos/octo/project/contents/src/index.ts?ref=main', 'put'),
      httpRequest('directory-read', 'https://api.github.com/repos/octo/project/contents?ref=main', 'get'),
      httpRequest('empty-file-path', 'https://api.github.com/repos/octo/project/contents/', 'GET'),
      httpRequest('file-read', 'https://api.github.com/repos/octo/project/contents/README.md?ref=main', 'gEt'),
      httpRequest('watch-scope', 'https://api.github.com/user/subscriptions?per_page=1&page=1', 'GET'),
      httpRequest('watch-notifications', 'https://api.github.com/notifications?all=true&per_page=1', 'GET'),
      httpRequest('watch-subject', 'https://api.github.com/repos/octo/project/issues/17', 'GET'),
    ]) {
      client.emit('Fetch.requestPaused', request);
    }
    await assertControlledProviderHealthy(control);

    assert.deepEqual([...observedRequests].sort(), [...fixtures.keys()].sort());
    assert.deepEqual(
      control.httpFixtureCapture
        .map(({ kind, method, route, status }) => ({ kind, method, route, status }))
        .sort((left, right) => left.kind.localeCompare(right.kind)),
      [
        { kind: 'repository-directory', method: 'GET', route: 'github-contents', status: 200 },
        { kind: 'repository-empty-file-path', method: 'GET', route: 'unknown-http-route', status: 404 },
        { kind: 'repository-file-read', method: 'GET', route: 'github-contents-file', status: 206 },
        { kind: 'repository-file-write', method: 'PUT', route: 'github-contents-file', status: 201 },
        { kind: 'watch-notifications-probe', method: 'GET', route: 'github-notifications', status: 200 },
        { kind: 'watch-scope-probe', method: 'GET', route: 'github-watch-scope', status: 200 },
        { kind: 'watch-subject-detail', method: 'GET', route: 'github-watch-subject', status: 200 },
      ],
    );
    assert.deepEqual(
      client.calls
        .filter(({ method }) => method === 'Fetch.fulfillRequest')
        .map(({ params }) => [params.requestId, params.responseCode])
        .sort(([left], [right]) => left.localeCompare(right)),
      [
        ['directory-read', 200],
        ['empty-file-path', 404],
        ['file-read', 206],
        ['file-write', 201],
        ['watch-notifications', 200],
        ['watch-scope', 200],
        ['watch-subject', 200],
      ],
    );

    await closeControlledResponsesProvider(control);
  });

});

function responsesRequest(requestId) {
  return {
    requestId,
    resourceType: 'Fetch',
    request: {
      url: 'https://api.openai.com/v1/responses',
      method: 'POST',
      headers: { Authorization: 'Bearer runtime-secret' },
      postData: JSON.stringify({ model: 'runtime-model', input: [], tools: [] }),
    },
  };
}

function responsesRequestWithInput(requestId, inputItemCount) {
  const request = responsesRequest(requestId);
  request.request.postData = JSON.stringify({
    model: 'runtime-model',
    input: Array.from({ length: inputItemCount }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `private-input-canary-${index}`,
    })),
    tools: [],
  });
  return request;
}

function httpRequest(requestId, url, method) {
  return {
    requestId,
    resourceType: 'Fetch',
    request: { url, method, headers: {} },
  };
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Controlled provider unit condition did not become true.');
}
