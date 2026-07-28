#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchExtensionBrowser } from './puppeteer-runtime.mjs';

const DIST = path.resolve(process.cwd(), process.env.GSM_DIST_DIR ?? 'dist');
const OPTIONS_PATH = '/src/options/index.html';
const ROW_COUNT = 501;
const TIMEOUT_MS = 30_000;
const RUN_WORKER_RECOVERY = process.env.GSM_RUNTIME_WORKER_RECOVERY === '1';
const WORKER_RECOVERY_TIMEOUT_MS = 90_000;

if (!existsSync(path.join(DIST, 'manifest.json'))) {
  throw new Error(`No production extension at ${DIST}; run pnpm build first.`);
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'bgsm-organize-job-host-'));
let browser;

try {
  browser = await launchExtensionBrowser({ dist: DIST, userDataDir: profile });
  const { extId, target } = await findExtension(browser);
  const worker = await target.worker();
  worker?.on('console', (message) => {
    if (message.type() === 'error') console.error(`[service-worker] ${message.text()}`);
  });
  const page = await openExtensionPage(browser, extId);
  await page.evaluate(installOrganizeJobRunDeliveryCollector);

  const provider = await installControlledProvider(target);
  await seedRepositories(page, ROW_COUNT);
  const beforeUnaccepted = provider.capture.length;
  const unaccepted = await page.evaluate(testConnectionWithoutAcceptance);
  assert.equal(unaccepted.ok, true);
  assert.equal(provider.capture.length > beforeUnaccepted, true);
  await configureSavedProvider(page, provider);
  const beforeCapability = provider.capture.length;
  const capabilityDenied = await page.evaluate(runMissingCapabilityScenario, { timeoutMs: TIMEOUT_MS });
  assert.equal(capabilityDenied.terminalReason, 'provider_error');
  assert.equal(provider.capture.length, beforeCapability);
  const savedCapability = await establishSavedProviderCapability(page, provider);
  assert.equal(savedCapability.source, 'builtin-official');
  assert.equal(savedCapability.contextWindow, 1_050_000);
  assert.equal(savedCapability.maxOutputTokens, 128_000);

  console.log('\n1) Transient typed key stays diagnostic-only');
  const transient = await page.evaluate(testTransientTypedKey);
  assert.equal(transient.ok, true);
  assert.equal(transient.savedCredentialUnchanged, true);
  assert.equal(transient.savedCapabilityUnchanged, true);
  console.log('  ✓ transient key completed a real probe without changing saved credential/capability authority');

  console.log('\n2) Full scope, exact RunBudget exhaustion, and automatic continuation');
  provider.analyzerMode = 'unchanged';
  const beforePreflight = provider.capture.length;
  const preflightOnly = await page.evaluate(runPreflightOnlyScenario, {
    rowCount: ROW_COUNT,
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(preflightOnly.count, ROW_COUNT);
  assert.equal(provider.capture.length, beforePreflight);
  let organize;
  try {
    organize = await page.evaluate(runOrganizeBudgetContinuationScenario, {
      rowCount: ROW_COUNT,
      timeoutMs: TIMEOUT_MS,
    });
  } catch (error) {
    console.error('Controlled provider capture before failure:', provider.capture);
    throw error;
  }
  assert.equal(organize.count, ROW_COUNT);
  assert.equal(organize.snapshotBounded, true);
  assert.deepEqual(organize.budget, {
    wallDeadlineMs: 300_000,
    maxConsumedFrozenPositions: 500,
    maxAnalyzerBatches: 20,
    maxProviderAttempts: 24,
    maxSerializedOutboundRequestBytes: 8_388_608,
    maxRequestedOutputTokens: 32_000,
  });
  assert.equal(organize.exhaustionReason, 'requested_output_tokens');
  assert.equal(organize.exhaustedUsage.consumedFrozenPositions, 175);
  assert.equal(organize.exhaustedUsage.analyzerBatches, 7);
  assert.equal(organize.exhaustedUsage.providerAttempts, 7);
  assert.equal(organize.exhaustedUsage.requestedOutputTokens, 28_672);
  assert.equal(organize.continuationCount, 2);
  assert.equal(organize.continuationGeneration > organize.parentGeneration, true);
  assert.equal(organize.continuationTerminalState, 'completed');
  assert.equal(organize.disconnected, true);
  assert.equal(organize.deliveryMetadata[0]?.deliverySequence, 0);
  assert.equal(organize.deliveryMetadata.every((delivery, index) => delivery.deliverySequence === index), true);
  assert.equal(new Set(organize.deliveryMetadata.map((delivery) => delivery.connectionEpochId)).size, 1);
  console.log('  ✓ requested-token budget stopped before attempt 8 and automatic continuations completed all rows');

  console.log('\n3) Closing the panel does not stop durable Analysis');
  provider.analyzerMode = 'unchanged';
  provider.stallNextAnalyzer = true;
  const active = await page.evaluate(beginActiveProviderReadScenario, { timeoutMs: TIMEOUT_MS });
  await waitUntil(() => typeof provider.releaseStall === 'function', TIMEOUT_MS);
  const activeDisconnect = await page.evaluate(disconnectActiveProviderReadScenario);
  assert.equal(activeDisconnect.detached, true);
  await provider.releaseStall().catch(() => {});
  provider.releaseStall = null;
  const activeCompletion = await page.evaluate(waitForOrganizeJobRemoval, {
    jobId: active.jobId,
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(activeCompletion.removed, true);
  console.log('  ✓ the Port detached immediately and the no-change job released its durable slot');

  console.log('\n4) Durable full-library Review and chunked Apply produce one receipt');
  provider.analyzerMode = 'actionable-all';
  provider.actionTag = 'runtime-full-library';
  const durable = await page.evaluate(runDurableFullLibraryApplyScenario, {
    rowCount: ROW_COUNT,
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(durable.count, ROW_COUNT);
  assert.equal(durable.takeoverReason, 'already_started');
  assert.equal(durable.reviewTotal, ROW_COUNT);
  assert.equal(durable.firstReviewPageRows, 100);
  assert.equal(durable.selectedRepositories, ROW_COUNT);
  assert.equal(durable.selectedActions, ROW_COUNT);
  assert.deepEqual(durable.settledProgress, [100, 200, 300, 400, 500, 501]);
  assert.deepEqual(durable.receiptCounts, {
    total: ROW_COUNT,
    changed: ROW_COUNT,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  });
  assert.equal(durable.firstReceiptPageRows, 100);
  assert.equal(durable.receiptNextOffset, 100);
  assert.equal(durable.deliveryMetadata[0]?.deliverySequence, 0);
  assert.equal(durable.deliveryMetadata.some((delivery) => delivery.durableRevision !== null), true);
  console.log('  ✓ active ownership stayed with the first tab; 501 repositories reached one paged Review and one 100/100/100/100/100/1 Apply receipt');

  console.log('\n5) Custom-host denial is fail-closed before provider network');
  const beforeDenied = provider.capture.length;
  const denied = await page.evaluate(testDeniedCustomHost);
  const afterDenied = provider.capture.length;
  assert.equal(denied.ok, false);
  assert.match(denied.error, /host permission|access|allow this ai service/i);
  assert.equal(afterDenied, beforeDenied);
  console.log('  ✓ missing optional host permission caused zero provider fetches');

  if (RUN_WORKER_RECOVERY) {
    console.log('\n6) A real Chrome alarm resumes Analysis after MV3 worker termination');
    provider.analyzerMode = 'actionable-all';
    provider.actionTag = 'runtime-worker-recovery';
    provider.stallNextAnalyzer = true;
    const recoveryCaptureStart = provider.capture.length;
    const recoveryStart = await page.evaluate(beginWorkerRecoveryScenario, {
      rowCount: ROW_COUNT,
      timeoutMs: TIMEOUT_MS,
    });
    await waitUntil(() => typeof provider.releaseStall === 'function', TIMEOUT_MS);
    const expiredLease = await page.evaluate(expireActiveAnalysisLeaseForRuntime);
    assert.equal(expiredLease.jobId, recoveryStart.jobId);
    assert.equal(expiredLease.alarmName, 'bgsm-organize-analysis-recovery-v1');

    const browserClient = await browser.target().createCDPSession();
    const replacementErrors = [];
    const serviceWorkerClient = await page.target().createCDPSession();
    let workerVersions = [];
    serviceWorkerClient.on('ServiceWorker.workerVersionUpdated', (event) => {
      workerVersions = event.versions;
    });
    await serviceWorkerClient.send('ServiceWorker.enable');
    await waitUntil(
      () => workerVersions.some((version) => (
        version.scriptURL?.startsWith(`chrome-extension://${extId}/`) &&
        version.runningStatus === 'running'
      )),
      TIMEOUT_MS,
    );
    const activeWorkerVersion = workerVersions.find((version) => (
      version.scriptURL?.startsWith(`chrome-extension://${extId}/`) &&
      version.runningStatus === 'running'
    ));
    assert.ok(activeWorkerVersion?.versionId);
    let replacementAttached = false;
    let replacementFailure = null;
    const replacementReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Replacement MV3 service worker did not start.')),
        WORKER_RECOVERY_TIMEOUT_MS,
      );
      browserClient.on('Target.attachedToTarget', (event) => {
        if (
          replacementAttached ||
          event.targetInfo.type !== 'service_worker' ||
          !event.targetInfo.url.startsWith(`chrome-extension://${extId}/`)
        ) return;
        replacementAttached = true;
        void (async () => {
          const replacementClient = browserClient.connection().session(event.sessionId);
          if (!replacementClient) throw new Error('Replacement service worker CDP session is unavailable.');
          await installControlledProviderClient(replacementClient, provider);
          await replacementClient.send('Runtime.enable');
          replacementClient.on('Runtime.consoleAPICalled', (message) => {
            if (message.type === 'error') {
              replacementErrors.push(message.args.map((argument) => argument.value).join(' '));
              console.error('[replacement-service-worker]', ...message.args.map((argument) => argument.value));
            }
          });
          await replacementClient.send('Runtime.runIfWaitingForDebugger');
          clearTimeout(timeout);
          resolve(event.targetInfo);
        })().catch((error) => {
          replacementFailure = error;
          clearTimeout(timeout);
          reject(error);
        });
      });
    });
    await browserClient.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [
        { type: 'service_worker', exclude: false },
        { exclude: true },
      ],
    });
    await serviceWorkerClient.send('ServiceWorker.stopWorker', {
      versionId: activeWorkerVersion.versionId,
    });
    await page.close();
    await replacementReady;
    if (replacementFailure) throw replacementFailure;
    await waitUntil(
      () => provider.capture
        .slice(recoveryCaptureStart)
        .filter((entry) => entry.kind === 'analyzer').length === Math.ceil(ROW_COUNT / 25),
      WORKER_RECOVERY_TIMEOUT_MS,
    );
    await browserClient.send('Target.setAutoAttach', {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

    const recoveryPage = await openExtensionPage(browser, extId);
    const recovered = await recoveryPage.evaluate(waitForRecoveredOrganizeState, {
      jobId: recoveryStart.jobId,
      expectedStatus: 'review',
      timeoutMs: TIMEOUT_MS,
    });
    const firstPageAttempts = provider.capture.slice(recoveryCaptureStart).filter((entry) => (
      (entry.kind === 'analyzer' || entry.kind === 'analyzer-stall') &&
      entry.batchStart === 0 &&
      entry.batchEnd === 25
    ));
    assert.equal(recovered.status, 'review');
    assert.equal(recovered.nextFrozenIndex, ROW_COUNT);
    assert.equal(firstPageAttempts.length, 2);
    assert.deepEqual(firstPageAttempts.map((entry) => entry.kind), ['analyzer-stall', 'analyzer']);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(replacementErrors, []);
    console.log('  ✓ alarm restored the expired lease, retried the interrupted first page once, and reached durable Review without UI');
  }

  const capture = provider.capture;
  assert.ok(capture.some((entry) => entry.kind === 'probe-tool'));
  assert.ok(capture.some((entry) => entry.kind === 'probe-ack'));
  assert.ok(capture.some((entry) => entry.authorization === 'Bearer transient-runtime-key'));
  assert.equal(capture.filter((entry) => entry.kind === 'analyzer').length >= 22, true);
  assert.equal(capture.every((entry) => entry.url === 'https://api.openai.com/v1/responses'), true);
  assert.equal(capture.every((entry) => entry.containsHiddenPolicy === false), true);
  console.log(`\nOrganizeJobRun extension-host runtime passed (${capture.length} intercepted Responses requests, zero live traffic).`);
} finally {
  const browserProcess = browser?.process();
  await Promise.race([
    browser?.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (browserProcess && !browserProcess.killed) browserProcess.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}

async function findExtension(browser) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const extensions = await browser.extensions().catch(() => null);
    const extension = [...(extensions?.values() ?? [])].find((entry) =>
      entry.enabled && path.resolve(entry.path) === DIST,
    );
    const target = extension && browser.targets().find((entry) =>
      entry.type() === 'service_worker' && entry.url().startsWith(`chrome-extension://${extension.id}/`),
    );
    const worker = await target?.worker().catch(() => null);
    if (extension && worker) return { extId: extension.id, target };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('MV3 service worker did not become ready.');
}

async function openExtensionPage(browser, extId) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}${OPTIONS_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForSelector('#agent-api-key', { timeout: 10_000 });
  return page;
}

async function installControlledProvider(target, existingControl = null) {
  const client = await target.createCDPSession();
  return installControlledProviderClient(client, existingControl);
}

async function installControlledProviderClient(client, existingControl = null) {
  const capture = existingControl?.capture ?? [];
  const control = existingControl ?? {
    analyzerMode: 'unchanged',
    actionTag: 'runtime-e2e',
    stallNextAnalyzer: false,
  };
  control.client = client;
  control.capture = capture;
  control.releaseStall = null;
  await client.send('Fetch.enable', {
    patterns: [{ urlPattern: 'https://api.openai.com/*', requestStage: 'Request' }],
  });
  client.on('Fetch.requestPaused', (event) => {
    void (async () => {
      const body = JSON.parse(event.request.postData ?? '{}');
      const request = normalizeControlledProviderRequest(body, event.request.url);
      let kind = 'unknown';
      let completion;
      let analyzerBatch = null;

      if (request.toolName === 'bgsm_connection_probe') {
        kind = 'probe-tool';
        completion = {
          toolCall: {
            id: 'call-runtime-probe',
            name: request.toolName,
            arguments: JSON.stringify({ nonce: 'bgsm' }),
          },
        };
      } else if (request.hasToolResult && request.priorToolNames.includes('bgsm_connection_probe')) {
        kind = 'probe-ack';
        completion = { content: 'runtime provider ready' };
      } else if (request.toolName === 'submit_semantic_tag_batch_proposal') {
        kind = control.stallNextAnalyzer ? 'analyzer-stall' : 'analyzer';
        control.stallNextAnalyzer = false;
        const { batch } = JSON.parse(request.userText || '{}');
        analyzerBatch = batch;
        const classifications = batch.repositories.map((repository, index) => ({
          frozenIndex: repository.frozenIndex,
          repositoryId: repository.repositoryId,
          sourceFingerprint: repository.sourceFingerprint,
          classifications: (
            control.analyzerMode === 'actionable-all' ||
            (control.analyzerMode === 'actionable' && index === 0)
          )
            ? [{ kind: 'propose_new_tag', tag: control.actionTag, evidence: 'Synthetic runtime evidence.' }]
            : [{ kind: 'unchanged', evidence: 'Synthetic unchanged runtime classification.' }],
        }));
        completion = {
          toolCall: {
            id: `call-runtime-analyzer-${capture.length + 1}`,
            name: request.toolName,
            arguments: JSON.stringify({
              version: 1,
              runId: batch.runId,
              generation: batch.generation,
              scopeFingerprint: batch.scopeFingerprint,
              rows: classifications,
            }),
          },
        };
      } else {
        throw new Error(`Unexpected controlled provider request: ${JSON.stringify(body.tool_choice)}`);
      }

      const authorization = event.request.headers.Authorization ?? event.request.headers.authorization ?? null;
      capture.push({
        kind,
        url: event.request.url,
        authorization,
        containsHiddenPolicy: (event.request.postData ?? '').includes('runtime-hidden-policy'),
        batchStart: analyzerBatch?.repositories?.[0]?.frozenIndex ?? null,
        batchEnd: analyzerBatch?.repositories?.at(-1)?.frozenIndex + 1 || null,
      });
      const controlledResponse = request.protocol === 'responses'
        ? { body: buildResponsesSse(completion, capture.length), contentType: 'text/event-stream' }
        : { body: buildChatCompletion(completion, body.model, capture.length), contentType: 'application/json' };
      const fulfill = () => client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: controlledResponse.contentType }],
        body: Buffer.from(controlledResponse.body).toString('base64'),
      });
      if (kind === 'analyzer-stall') {
        let released = false;
        control.releaseStall = async () => {
          if (released) return;
          released = true;
          await fulfill();
        };
        return;
      }
      await fulfill();
    })().catch(async (error) => {
      console.error('controlled provider interception failed:', error);
      await client.send('Fetch.failRequest', {
        requestId: event.requestId,
        errorReason: 'Failed',
      }).catch(() => {});
    });
  });
  return control;
}

function normalizeControlledProviderRequest(body, url) {
  const protocol = url.endsWith('/responses') ? 'responses' : 'chat';
  if (protocol === 'responses') {
    const input = Array.isArray(body.input) ? body.input : [];
    const user = [...input].reverse().find((entry) => entry?.role === 'user');
    const userText = Array.isArray(user?.content)
      ? user.content.filter((part) => part?.type === 'input_text').map((part) => part.text).join('')
      : '';
    return {
      protocol,
      toolName: body.tool_choice?.type === 'function' ? body.tool_choice.name : null,
      hasToolResult: input.some((entry) => entry?.type === 'function_call_output'),
      priorToolNames: input.filter((entry) => entry?.type === 'function_call').map((entry) => entry.name),
      offeredToolNames: (body.tools ?? []).map((tool) => tool.name),
      userText,
    };
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = [...messages].reverse().find((entry) => entry?.role === 'user');
  return {
    protocol,
    toolName: body.tool_choice?.function?.name ?? null,
    hasToolResult: messages.some((message) => message?.role === 'tool'),
    priorToolNames: messages.flatMap((message) =>
      message?.tool_calls?.map((call) => call.function?.name) ?? []),
    offeredToolNames: (body.tools ?? []).map((tool) => tool.function?.name),
    userText: typeof user?.content === 'string' ? user.content : '',
  };
}

function buildChatCompletion(completion, model, sequence) {
  const message = completion.toolCall
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: completion.toolCall.id,
          type: 'function',
          function: {
            name: completion.toolCall.name,
            arguments: completion.toolCall.arguments,
          },
        }],
      }
    : { role: 'assistant', content: completion.content };
  return JSON.stringify({
    id: `chatcmpl-runtime-${sequence}`,
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: completion.toolCall ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
}

function buildResponsesSse(completion, sequence) {
  const responseId = `resp_runtime_${sequence}`;
  const events = [{
    type: 'response.created',
    response: { id: responseId, status: 'in_progress' },
  }];
  if (completion.toolCall) {
    const itemId = `fc_runtime_${sequence}`;
    const call = completion.toolCall;
    events.push(
      {
        type: 'response.output_item.added', response_id: responseId, output_index: 0,
        item: { id: itemId, type: 'function_call', call_id: call.id, name: call.name, arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta', response_id: responseId,
        item_id: itemId, output_index: 0, delta: call.arguments,
      },
      {
        type: 'response.function_call_arguments.done', response_id: responseId,
        item_id: itemId, output_index: 0, arguments: call.arguments,
      },
      {
        type: 'response.output_item.done', response_id: responseId, output_index: 0,
        item: {
          id: itemId, type: 'function_call', status: 'completed', call_id: call.id,
          name: call.name, arguments: call.arguments,
        },
      },
    );
  } else {
    const itemId = `msg_runtime_${sequence}`;
    const text = completion.content ?? '';
    events.push(
      {
        type: 'response.output_item.added', response_id: responseId, output_index: 0,
        item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      },
      {
        type: 'response.content_part.added', response_id: responseId, item_id: itemId,
        output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta', response_id: responseId, item_id: itemId,
        output_index: 0, content_index: 0, delta: text,
      },
      {
        type: 'response.output_text.done', response_id: responseId, item_id: itemId,
        output_index: 0, content_index: 0, text,
      },
      {
        type: 'response.content_part.done', response_id: responseId, item_id: itemId,
        output_index: 0, content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      },
      {
        type: 'response.output_item.done', response_id: responseId, output_index: 0,
        item: {
          id: itemId, type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      },
    );
  }
  events.push({
    type: 'response.completed',
    response: {
      id: responseId,
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    },
  });
  return events.map((entry) => `event: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`).join('');
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for controlled runtime state.');
}

async function seedRepositories(page, count) {
  await page.evaluate(async (rowCount) => {
    const request = indexedDB.open('better-github-stars-manager');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['stars', 'tags', 'tagMeta'], 'readwrite');
    const stars = tx.objectStore('stars');
    const tags = tx.objectStore('tags');
    stars.clear();
    tags.clear();
    tx.objectStore('tagMeta').clear();
    tx.objectStore('tagMeta').put({
      name: 'runtime-hidden-policy',
      dimension: null,
      color: null,
      mtime: '2026-07-14T00:00:00.000Z',
      excluded: true,
    });
    const now = '2026-07-14T00:00:00.000Z';
    for (let index = 0; index < rowCount; index += 1) {
      const id = `runtime/repo-${String(index).padStart(3, '0')}`;
      stars.put({
        full_name: id,
        html_url: `https://github.com/${id}`,
        description: `Runtime repository ${index}`,
        language: index % 2 ? 'TypeScript' : 'Rust',
        stargazers_count: index,
        topics: ['runtime'],
        pushed_at: now,
        created_at: now,
        fork: false,
        archived: false,
        starred_at: now,
        tombstone: false,
        synced_at: now,
      });
      tags.put({
        full_name: id,
        manualTags: [],
        autoTags: ['runtime-hidden-policy'],
        dismissedAutoTags: [],
        manualTagsMtime: now,
        autoTagsMtime: now,
        dismissedAutoTagsMtime: now,
        notes: '',
        mtime: now,
      });
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    await chrome.runtime.sendMessage({ type: 'getStatus' });
  }, count);
}

async function configureSavedProvider(page, provider) {
  await page.$eval('#agent-api-key', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'runtime-provider-key');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) =>
    /^Save & test$/i.test(button.textContent.trim()) && !button.disabled,
  ));
  await clickButton(page, /^Save & test$/i);
  await pollPageConfig(page, (config) => !!config?.agentProvider?.apiKeyEncrypted);
  await pollPageConfig(page, (config) => config?.agentProvider?.capability?.namedToolRoundTrip === true);
  await page.evaluate(async () => {
    const stored = await chrome.storage.local.get('gsm_config');
    const config = stored.gsm_config;
    await chrome.storage.local.set({
      gsm_config: {
        ...config,
        agentProvider: {
          ...config.agentProvider,
          capability: null,
        },
      },
    });
  });
  await pollPageConfig(page, (config) => config?.agentProvider?.capability === null);
}

async function establishSavedProviderCapability(page, provider) {
  await clickButton(page, /^Test connection$/i);
  try {
    await pollPageConfig(page, (config) => config?.agentProvider?.capability?.namedToolRoundTrip === true);
  } catch (error) {
    const [body, capture] = await Promise.all([
      page.evaluate(() => document.body.innerText),
      Promise.resolve(provider.capture),
    ]);
    throw new Error(`Provider capability probe failed: ${JSON.stringify({ body, capture })}`, { cause: error });
  }
  return page.evaluate(async () => {
    const stored = await chrome.storage.local.get('gsm_config');
    return stored.gsm_config?.agentProvider?.capability?.contextCapability ?? null;
  });
}

async function testConnectionWithoutAcceptance() {
  return chrome.runtime.sendMessage({
    type: 'testAgentProviderConnection',
    provider: 'openai',
    baseUrl: null,
    model: 'gpt-5-mini',
    apiKey: 'runtime-key-without-acceptance',
  });
}

async function runMissingCapabilityScenario({ timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const deliveryMetadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, deliveryMetadata);
  });
  const controllerId = `controller:v1:runtime-capability-denied-${crypto.randomUUID()}`;
  const sessionId = `runtime-capability-denied-${crypto.randomUUID()}`;
  const waitFor = async (predicate) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...messages].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Missing-capability scenario timed out: ${JSON.stringify(messages.slice(-4))}`);
  };
  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId,
    sessionId,
    requestId: 'runtime-capability-denied-preflight',
  });
  const preflight = await waitFor((message) => message.type === 'bgsmOrganizeJobRunPreflightResult');
  port.postMessage({
    type: 'startBgsmOrganizeJob',
    controllerId,
    sessionId,
    preflightToken: preflight.preflightToken,
    taskInstruction: 'This must stop before provider access.',
  });
  const terminal = await waitFor((message) =>
    message.type === 'bgsmOrganizeJobRunEvent' && message.event.type === 'run_terminal');
  port.postMessage({ type: 'disconnectBgsmOrganizeJob', controllerId, sessionId });
  port.disconnect();
  return { terminalReason: terminal.event.reason, deliveryMetadata };
}

function installOrganizeJobRunDeliveryCollector() {
  globalThis.__recordBgsmOrganizeJobDelivery = (delivery, messages, metadata) => {
    if (!delivery || delivery.type !== 'bgsmOrganizeJobRunDelivery' || !delivery.message) {
      messages.push({ type: 'runtimeInvalidOrganizeJobRunDelivery' });
      return;
    }
    metadata.push({
      connectionEpochId: delivery.connectionEpochId,
      deliverySequence: delivery.deliverySequence,
      deliveryKind: delivery.deliveryKind,
      durableRevision: delivery.durableRevision,
      messageType: delivery.message.type,
      eventType: delivery.message.event?.type ?? null,
    });
    messages.push(delivery.message);
  };
}

async function pollPageConfig(page, predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const config = await page.evaluate(async () =>
      (await chrome.storage.local.get('gsm_config')).gsm_config,
    );
    if (predicate(config)) return config;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for BGSM Agent config state.');
}

async function clickButton(page, matcher) {
  const found = await page.evaluate(({ source, flags }) => {
    const pattern = new RegExp(source, flags);
    const button = [...document.querySelectorAll('button')].find((entry) =>
      pattern.test(entry.textContent.trim()) && !entry.disabled,
    );
    button?.click();
    return !!button;
  }, { source: matcher.source, flags: matcher.flags });
  assert.equal(found, true, `button not found: ${matcher}`);
}

async function testTransientTypedKey() {
  const key = 'gsm_config';
  const before = (await chrome.storage.local.get(key))[key];
  const response = await chrome.runtime.sendMessage({
    type: 'testAgentProviderConnection',
    provider: 'openai',
    baseUrl: null,
    model: before.agentProvider.model,
    apiKey: 'transient-runtime-key',
  });
  const after = (await chrome.storage.local.get(key))[key];
  return {
    ok: response.ok,
    savedCredentialUnchanged:
      before.agentProvider.apiKeyEncrypted === after.agentProvider.apiKeyEncrypted &&
      before.agentProvider.credentialRevision === after.agentProvider.credentialRevision,
    savedCapabilityUnchanged:
      JSON.stringify(before.agentProvider.capability) === JSON.stringify(after.agentProvider.capability),
  };
}

async function runOrganizeBudgetContinuationScenario({ rowCount, timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const deliveryMetadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, deliveryMetadata);
  });
  port.onDisconnect.addListener(() => messages.push({
    type: 'runtimePortDisconnected',
    error: chrome.runtime.lastError?.message ?? null,
  }));
  const controllerId = `controller:v1:runtime-preflight-${crypto.randomUUID()}`;
  const sessionId = `runtime-preflight-${crypto.randomUUID()}`;
  const waitFor = async (predicate) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...messages].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const counts = Object.fromEntries(Object.entries(messages.reduce((result, message) => {
      const key = message.event?.type ?? message.type;
      result[key] = (result[key] ?? 0) + 1;
      return result;
    }, {})));
    throw new Error(`Timed out; counts: ${JSON.stringify(counts)}; last: ${JSON.stringify(messages.slice(-5).map((message) => ({
      type: message.type, eventType: message.event?.type ?? null,
      state: message.event?.state ?? message.snapshot?.state ?? null,
      reason: message.event?.reason ?? null,
    })))}`);
  };
  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight', controllerId, sessionId,
    requestId: 'runtime-preflight',
  });
  const result = await waitFor((message) => message.type === 'bgsmOrganizeJobRunPreflightResult');
  if (result.count !== rowCount) throw new Error(`Expected ${rowCount}, got ${result.count}`);
  port.postMessage({
    type: 'startBgsmOrganizeJob',
    controllerId,
    sessionId,
    preflightToken: result.preflightToken,
    taskInstruction: 'Organize the complete runtime scope.',
  });
  const started = await waitFor((message) => message.type === 'bgsmOrganizeJobRunSnapshot');
  const scope = started.snapshot?.frozenScope;
  if (!scope || scope.count !== rowCount) {
    throw new Error(`Unexpected start snapshot: ${JSON.stringify(started)}`);
  }
  const snapshotBounded = !('repositoryIds' in scope) && !('filterSnapshot' in scope);
  const exhausted = await waitFor((message) =>
    message.type === 'bgsmOrganizeJobRunEvent' &&
    message.event.type === 'budget_exhausted' &&
    message.event.runId === started.snapshot.runId,
  );
  let continuation = started;
  let continuationTerminal = null;
  let continuationCount = 0;
  while (!continuationTerminal) {
    const parent = continuation.snapshot;
    const child = await waitFor((message) =>
      message.type === 'bgsmOrganizeJobRunSnapshot' &&
      message.snapshot.generation > parent.generation &&
      message.snapshot.state === 'prepared',
    );
    continuationCount += 1;
    continuation = child;
    const outcome = await waitFor((message) =>
      message.type === 'bgsmOrganizeJobRunEvent' &&
      message.event.runId === child.snapshot.runId &&
      (message.event.type === 'budget_exhausted' || message.event.type === 'run_terminal'),
    );
    if (outcome.event.type === 'budget_exhausted') {
      continue;
    } else {
      continuationTerminal = outcome;
    }
  }

  port.postMessage({ type: 'disconnectBgsmOrganizeJob', controllerId, sessionId });
  port.disconnect();
  return {
    count: result.count,
    snapshotBounded,
    budget: started.snapshot.budget,
    exhaustionReason: exhausted.event.reason,
    exhaustedUsage: exhausted.event.usage,
    parentGeneration: started.snapshot.generation,
    continuationGeneration: continuation.snapshot.generation,
    continuationCount,
    continuationTerminalState: continuationTerminal.event.state,
    disconnected: true,
    deliveryMetadata,
  };
}

async function runPreflightOnlyScenario({ rowCount, timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const deliveryMetadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, deliveryMetadata);
  });
  const controllerId = `controller:v1:runtime-preflight-only-${crypto.randomUUID()}`;
  const sessionId = `runtime-preflight-only-${crypto.randomUUID()}`;
  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId,
    sessionId,
    requestId: 'runtime-preflight-only',
  });
  const deadline = Date.now() + timeoutMs;
  let preflight = null;
  while (Date.now() < deadline) {
    preflight = messages.find((message) => message.type === 'bgsmOrganizeJobRunPreflightResult');
    if (preflight) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!preflight) throw new Error(`Preflight-only scenario timed out: ${JSON.stringify(messages)}`);
  if (preflight.count !== rowCount) throw new Error(`Expected ${rowCount}, got ${preflight.count}`);
  port.postMessage({ type: 'disconnectBgsmOrganizeJob', controllerId, sessionId });
  port.disconnect();
  return { count: preflight.count, deliveryMetadata };
}

async function runDurableFullLibraryApplyScenario({ rowCount, timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const deliveryMetadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, deliveryMetadata);
  });
  const controllerId = `controller:v1:runtime-durable-${crypto.randomUUID()}`;
  const sessionId = `runtime-durable-${crypto.randomUUID()}`;
  const waitFor = async (predicate) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...messages].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for durable full-library Apply: ${JSON.stringify(messages.slice(-6))}`);
  };

  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId,
    sessionId,
    requestId: 'runtime-durable-preflight',
  });
  const preflight = await waitFor((message) => message.type === 'bgsmOrganizeJobRunPreflightResult');
  port.postMessage({
    type: 'startBgsmOrganizeJob',
    controllerId,
    sessionId,
    preflightToken: preflight.preflightToken,
    taskInstruction: 'Propose one synthetic tag for every repository in the complete local library.',
  });
  const reviewState = await waitFor((message) =>
    message.type === 'bgsmOrganizeJobState' && message.presentation.status === 'review');
  const job = reviewState.presentation;
  const observerPort = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const observerMessages = [];
  const observerDeliveryMetadata = [];
  observerPort.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, observerMessages, observerDeliveryMetadata);
  });
  observerPort.postMessage({
    type: 'requestBgsmActiveOrganizeJob',
    controllerId: `controller:v1:runtime-observer-${crypto.randomUUID()}`,
    sessionId: `runtime-observer-${crypto.randomUUID()}`,
  });
  const observerDeadline = Date.now() + timeoutMs;
  let takeoverError = null;
  while (Date.now() < observerDeadline) {
    takeoverError = observerMessages.find((message) => message.type === 'bgsmOrganizeJobRunError') ?? null;
    if (takeoverError) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  observerPort.disconnect();
  if (!takeoverError) {
    throw new Error(`Timed out waiting for dual-tab takeover rejection: ${JSON.stringify(observerMessages)}`);
  }
  port.postMessage({
    type: 'requestBgsmOrganizeReviewPage',
    controllerId,
    sessionId,
    runId: job.runId,
    generation: job.generation,
    requestId: 'runtime-durable-review-page',
    jobId: job.jobId,
    rowOffset: 0,
    limit: 100,
  });
  const reviewPage = await waitFor((message) =>
    message.type === 'bgsmOrganizeReviewPage' && message.requestId === 'runtime-durable-review-page');

  port.postMessage({
    type: 'applyBgsmOrganizeSelection',
    controllerId,
    sessionId,
    runId: job.runId,
    generation: job.generation,
    jobId: job.jobId,
    expectedRevision: reviewPage.revision,
  });
  const completed = await waitFor((message) =>
    message.type === 'bgsmOrganizeJobState' &&
    message.presentation.jobId === job.jobId &&
    message.presentation.status === 'completed');
  const apply = completed.presentation.apply;
  if (!apply) throw new Error('Durable completion did not expose Apply progress.');

  port.postMessage({
    type: 'requestBgsmOrganizeReceiptPage',
    controllerId,
    sessionId,
    runId: job.runId,
    generation: job.generation,
    requestId: 'runtime-durable-receipt-page',
    jobId: job.jobId,
    applyId: apply.applyId,
    rowOffset: 0,
    limit: 100,
    filter: 'all',
  });
  const receiptPage = await waitFor((message) =>
    message.type === 'bgsmOrganizeReceiptPage' && message.requestId === 'runtime-durable-receipt-page');
  const settledProgress = [...new Set(messages
    .filter((message) =>
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation.jobId === job.jobId &&
      (message.presentation.apply?.settled ?? 0) > 0)
    .map((message) => message.presentation.apply.settled))];

  port.postMessage({
    type: 'dismissBgsmOrganizeReceipt',
    controllerId,
    sessionId,
    runId: job.runId,
    generation: job.generation,
    jobId: job.jobId,
    applyId: apply.applyId,
  });
  port.postMessage({ type: 'disconnectBgsmOrganizeJob', controllerId, sessionId });
  port.disconnect();
  return {
    takeoverReason: takeoverError.reason,
    count: preflight.count,
    reviewTotal: reviewPage.totalRows,
    firstReviewPageRows: reviewPage.rows.length,
    selectedRepositories: reviewPage.selectedRepositories,
    selectedActions: reviewPage.selectedActions,
    settledProgress,
    receiptCounts: {
      total: apply.total,
      changed: apply.changed,
      unchanged: apply.unchanged,
      skipped: apply.skipped,
      failed: apply.failed,
    },
    firstReceiptPageRows: receiptPage.rows.length,
    receiptNextOffset: receiptPage.nextRowOffset,
    deliveryMetadata,
  };
}




async function beginWorkerRecoveryScenario({ rowCount, timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const metadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, metadata);
  });
  const controllerId = `controller:v1:runtime-worker-recovery-${crypto.randomUUID()}`;
  const sessionId = `runtime-worker-recovery-${crypto.randomUUID()}`;
  const waitFor = async (predicate) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...messages].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Worker-recovery start timed out: ${JSON.stringify(messages.slice(-5))}`);
  };
  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId,
    sessionId,
    requestId: 'runtime-worker-recovery-preflight',
  });
  const preflight = await waitFor((message) => message.type === 'bgsmOrganizeJobRunPreflightResult');
  if (preflight.count !== rowCount) throw new Error(`Expected ${rowCount}, got ${preflight.count}`);
  port.postMessage({
    type: 'startBgsmOrganizeJob',
    controllerId,
    sessionId,
    preflightToken: preflight.preflightToken,
    taskInstruction: 'Recover this complete runtime scope after worker termination.',
  });
  const snapshot = await waitFor((message) => message.type === 'bgsmOrganizeJobRunSnapshot');
  const durable = await waitFor((message) => (
    message.type === 'bgsmOrganizeJobState' && message.presentation?.status === 'analyzing'
  ));
  return {
    jobId: durable.presentation.jobId,
    runId: snapshot.snapshot.runId,
    generation: snapshot.snapshot.generation,
  };
}

async function expireActiveAnalysisLeaseForRuntime() {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const transaction = database.transaction(['organizeJobs', 'organizeItems'], 'readwrite');
    const jobsStore = transaction.objectStore('organizeJobs');
    const itemsStore = transaction.objectStore('organizeItems');
    const requestValue = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const jobs = await requestValue(jobsStore.getAll());
    const job = jobs.find((candidate) => candidate.status === 'analyzing');
    if (!job) throw new Error('Active durable analysis job is unavailable.');
    const items = await requestValue(itemsStore.getAll());
    const leased = items.filter((item) => (
      item.jobId === job.jobId && item.analysisState === 'leased'
    ));
    if (leased.length === 0) throw new Error('Active durable analysis lease is unavailable.');
    for (const item of leased) itemsStore.put({ ...item, leaseExpiresAt: 0 });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const alarmName = 'bgsm-organize-analysis-recovery-v1';
    await chrome.alarms.create(alarmName, { when: Date.now() + 1_000 });
    const alarm = await chrome.alarms.get(alarmName);
    if (!alarm) throw new Error('Organize analysis recovery alarm is unavailable.');
    return {
      jobId: job.jobId,
      leasedPositions: leased.map((item) => item.position),
      alarmName: alarm.name,
      scheduledTime: alarm.scheduledTime,
    };
  } finally {
    database.close();
  }
}

async function waitForRecoveredOrganizeState({ jobId, expectedStatus, timeoutMs }) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const transaction = database.transaction('organizeJobs', 'readonly');
      const request = transaction.objectStore('organizeJobs').get(jobId);
      const job = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (job?.status === expectedStatus) {
        return {
          status: job.status,
          nextFrozenIndex: job.nextFrozenIndex,
          revision: job.revision,
          usage: job.usage,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Recovered organize job ${jobId} did not reach ${expectedStatus}.`);
  } finally {
    database.close();
  }
}

async function waitForOrganizeJobRemoval({ jobId, timeoutMs }) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const transaction = database.transaction('organizeJobs', 'readonly');
      const request = transaction.objectStore('organizeJobs').get(jobId);
      const job = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!job) return { removed: true };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Organize job ${jobId} did not release its durable slot.`);
  } finally {
    database.close();
  }
}

async function beginActiveProviderReadScenario({ timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const deliveryMetadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, deliveryMetadata);
  });
  const controllerId = `controller:v1:runtime-active-disconnect-${crypto.randomUUID()}`;
  const sessionId = `runtime-active-disconnect-${crypto.randomUUID()}`;
  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId,
    sessionId,
    requestId: 'runtime-active-disconnect-preflight',
  });
  const deadline = Date.now() + timeoutMs;
  let preflight = null;
  while (Date.now() < deadline) {
    preflight = messages.find((message) => message.type === 'bgsmOrganizeJobRunPreflightResult');
    if (preflight) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!preflight) throw new Error(`Active disconnect preflight timed out: ${JSON.stringify(messages)}`);
  port.postMessage({
    type: 'startBgsmOrganizeJob',
    controllerId,
    sessionId,
    preflightToken: preflight.preflightToken,
    taskInstruction: 'Complete this durable analysis after the panel disconnects.',
  });
  let analyzing = null;
  while (Date.now() < deadline) {
    analyzing = [...messages].reverse().find((message) => (
      message.type === 'bgsmOrganizeJobRunSnapshot' &&
      message.snapshot?.state === 'analyzing'
    ));
    if (analyzing) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!analyzing) throw new Error(`Active analysis snapshot timed out: ${JSON.stringify(messages.slice(-5))}`);
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  let durable = null;
  try {
    while (Date.now() < deadline) {
      const transaction = database.transaction('organizeJobs', 'readonly');
      const request = transaction.objectStore('organizeJobs').getAll();
      const jobs = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      durable = jobs.find((job) => (
        job.controllerId === controllerId &&
        job.sessionId === sessionId &&
        job.status === 'analyzing'
      ));
      if (durable) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    database.close();
  }
  if (!durable) throw new Error('Durable analysis record timed out.');
  globalThis.__runtimeActiveProviderRead = {
    port,
    messages,
    deliveryMetadata,
    controllerId,
    sessionId,
  };
  return { jobId: durable.jobId };
}

async function disconnectActiveProviderReadScenario() {
  const state = globalThis.__runtimeActiveProviderRead;
  if (!state) throw new Error('Active provider-read state is unavailable.');
  state.port.postMessage({
    type: 'disconnectBgsmOrganizeJob',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  state.port.disconnect();
  delete globalThis.__runtimeActiveProviderRead;
  return { detached: true, deliveryMetadata: state.deliveryMetadata };
}

async function testDeniedCustomHost() {
  return chrome.runtime.sendMessage({
    type: 'testAgentProviderConnection',
    provider: 'custom-openai-compatible',
    baseUrl: 'https://runtime-denied.invalid/v1',
    model: 'runtime-model',
    apiKey: 'must-not-leave-extension',
  });
}
