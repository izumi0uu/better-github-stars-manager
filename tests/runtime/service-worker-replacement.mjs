import assert from 'node:assert/strict';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RUNTIME_ERROR_EVENTS = 16;
const MAX_IDENTITY_LENGTH = 160;
const MAX_TRANSITIONS_PER_VERSION = 16;

/**
 * Replaces the pinned Chrome MV3 worker through either its stopped CDP session
 * or a debugger-paused auto-attached target. Both modes install the Provider
 * gate before application code can run and record exact lifecycle identity.
 */
export async function createServiceWorkerReplacementController({
  page,
  extensionId,
  preinstallStoppedClient,
  preinstallAutoAttachedClient = null,
  settleStoppedClient = null,
  replacementMode = 'stopped_target_preinstalled',
  pauseRecoveryWakeups,
  resumeRecoveryWakeups,
  retireReplacementClient,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!page?.target) throw new TypeError('Worker replacement requires a Puppeteer page target.');
  if (!['stopped_target_preinstalled', 'paused_target_auto_attached'].includes(replacementMode)) {
    throw new TypeError('Worker replacement mode is invalid.');
  }
  if (
    (replacementMode === 'stopped_target_preinstalled' && typeof preinstallStoppedClient !== 'function')
    || (replacementMode === 'paused_target_auto_attached' && (
      typeof preinstallAutoAttachedClient !== 'function' || typeof settleStoppedClient !== 'function'
    ))
    || typeof retireReplacementClient !== 'function'
    || typeof pauseRecoveryWakeups !== 'function'
    || typeof resumeRecoveryWakeups !== 'function'
  ) {
    throw new TypeError('Worker replacement requires provider installation, retirement, and recovery-gate callbacks.');
  }
  assertPositiveTimeout(timeoutMs);

  const serviceWorkerClient = await page.target().createCDPSession();
  const versions = new Map();
  const transitions = new Map();
  let versionSequence = 0;
  let replacing = false;
  let closed = false;
  let runtimeMonitor = null;
  let autoAttachClient = null;
  let autoAttachActive = false;
  let autoAttachListener = null;
  const runtimeMonitorFor = (client) => {
    if (runtimeMonitor) {
      if (runtimeMonitor.client !== client) throw new Error('Replacement worker changed its preinstalled Runtime client.');
      return runtimeMonitor;
    }
    const monitor = {
      client,
      count: 0,
      onException: null,
      onConsole: null,
    };
    const record = () => {
      monitor.count = Math.min(Number.MAX_SAFE_INTEGER, monitor.count + 1);
    };
    monitor.onException = record;
    monitor.onConsole = (message) => {
      if (message.type === 'error') record();
    };
    client.on('Runtime.exceptionThrown', monitor.onException);
    client.on('Runtime.consoleAPICalled', monitor.onConsole);
    runtimeMonitor = monitor;
    return monitor;
  };
  const removeRuntimeMonitor = () => {
    const monitor = runtimeMonitor;
    if (!monitor) return;
    const remove = (event, listener) => {
      if (typeof monitor.client.off === 'function') monitor.client.off(event, listener);
      else monitor.client.removeListener?.(event, listener);
    };
    remove('Runtime.exceptionThrown', monitor.onException);
    remove('Runtime.consoleAPICalled', monitor.onConsole);
    runtimeMonitor = null;
  };
  const closeAutoAttach = async () => {
    const client = autoAttachClient;
    if (!client) return;
    if (autoAttachListener) {
      if (typeof client.off === 'function') client.off('Target.attachedToTarget', autoAttachListener);
      else client.removeListener?.('Target.attachedToTarget', autoAttachListener);
      autoAttachListener = null;
    }
    if (autoAttachActive) {
      await client.send('Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      }).catch(() => {});
      autoAttachActive = false;
    }
    await client.detach().catch(() => {});
    autoAttachClient = null;
  };

  const onVersionUpdated = (event) => {
    for (const update of event.versions ?? []) {
      const version = { ...(versions.get(update.versionId) ?? {}), ...update, sequence: ++versionSequence };
      versions.set(update.versionId, version);
      const history = transitions.get(update.versionId) ?? [];
      if (history.length >= MAX_TRANSITIONS_PER_VERSION) history.shift();
      history.push(Object.freeze({ ...version }));
      transitions.set(update.versionId, history);
    }
  };

  serviceWorkerClient.on('ServiceWorker.workerVersionUpdated', onVersionUpdated);
  await serviceWorkerClient.send('ServiceWorker.enable');
  await waitUntil(
    () => singleRunningExtensionVersion(versions, extensionId),
    timeoutMs,
    'The packaged extension service worker did not reach one running state.',
  );

  const replace = async () => {
    if (closed) throw new Error('Worker replacement controller is closed.');
    if (replacing) throw new Error('A worker replacement is already in progress.');
    replacing = true;
    let installedClient = null;
    let completed = false;
    let recoveryPaused = false;
    try {
      const oldVersion = singleRunningExtensionVersion(versions, extensionId);
      assert.ok(oldVersion, 'Exactly one running service-worker version is required before replacement.');
      const oldIdentity = versionIdentity(oldVersion, extensionId);
      const stopCommandOrdinal = versionSequence;
      await pauseRecoveryWakeups();
      recoveryPaused = true;
      if (replacementMode === 'paused_target_auto_attached') {
        const browser = page.browser?.();
        if (!browser?.target) throw new Error('Paused replacement requires a Puppeteer browser target.');
        autoAttachClient = await browser.target().createCDPSession();
        let attachmentAccepted = false;
        let resolveAttached;
        let rejectAttached;
        let attachmentTimer;
        const attachedReady = new Promise((resolve, reject) => {
          resolveAttached = resolve;
          rejectAttached = reject;
          attachmentTimer = setTimeout(
            () => reject(new Error('Paused auto-attached extension service worker did not appear.')),
            timeoutMs,
          );
        });
        autoAttachListener = (event) => {
          if (
            event.targetInfo?.type !== 'service_worker'
            || !isExtensionScript(event.targetInfo.url, extensionId)
          ) return;
          const client = autoAttachClient?.connection?.().session(event.sessionId);
          if (!client) {
            rejectAttached(new Error('Paused auto-attached replacement CDP session is unavailable.'));
            return;
          }
          if (attachmentAccepted) {
            void client.send('Runtime.runIfWaitingForDebugger').catch(() => {});
            return;
          }
          attachmentAccepted = true;
          void (async () => {
            const preinstalled = await preinstallAutoAttachedClient(client, oldIdentity);
            if (
              !preinstalled
              || preinstalled.client !== client
              || !preinstalled.installedClient
              || typeof preinstalled.attachmentId !== 'string'
            ) {
              throw new Error('Paused target provider preinstallation returned invalid evidence.');
            }
            installedClient = preinstalled.installedClient;
            const attachmentId = boundedIdentity(preinstalled.attachmentId, 'paused target attachment ID');
            const targetId = boundedIdentity(event.targetInfo.targetId, 'paused target ID');
            await client.send('Runtime.enable');
            const monitor = runtimeMonitorFor(client);
            const runtimeErrorBaseline = monitor.count;
            const gateInstalledOrdinal = versionSequence;
            await client.send('Runtime.runIfWaitingForDebugger');
            resolveAttached({
              client,
              attachmentId,
              targetId,
              monitor,
              runtimeErrorBaseline,
              gateInstalledOrdinal,
            });
          })().catch(rejectAttached);
        };
        autoAttachClient.on('Target.attachedToTarget', autoAttachListener);
        await autoAttachClient.send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [
            { type: 'service_worker', exclude: false },
            { exclude: true },
          ],
        });
        autoAttachActive = true;
        const attached = await attachedReady.finally(() => clearTimeout(attachmentTimer));
        if (attached.targetId !== oldIdentity.targetId) {
          throw new Error('Paused provider gate attached to a different service-worker target.');
        }
        const autoStopCommandOrdinal = versionSequence;
        await serviceWorkerClient.send('ServiceWorker.stopWorker', { versionId: oldIdentity.versionId });
        const stopped = await waitUntil(
          () => transitions.get(oldIdentity.versionId)?.find((version) => matchesIdentityAfter(
            version,
            oldIdentity,
            autoStopCommandOrdinal,
            'stopped',
            extensionId,
          )),
          timeoutMs,
          'The exact old service-worker identity did not report a current stopped transition.',
        );
        await settleStoppedClient(oldIdentity);
        const installCompletedOrdinal = Math.max(attached.gateInstalledOrdinal, stopped.sequence);
        const startCommandOrdinal = versionSequence;
        await serviceWorkerClient.send('ServiceWorker.startWorker', {
          scopeURL: `chrome-extension://${extensionId}/`,
        });
        await attached.client.send('Runtime.runIfWaitingForDebugger');
        const runningReplacement = await waitUntil(
          () => transitions.get(oldIdentity.versionId)?.find((version) => (
            version.sequence > startCommandOrdinal
            && version.registrationId === oldIdentity.registrationId
            && version.versionId === oldIdentity.versionId
            && version.targetId === oldIdentity.targetId
            && version.runningStatus === 'running'
            && extensionScriptRoute(version.scriptURL, extensionId) === oldIdentity.route
          )),
          timeoutMs,
          'The paused auto-attached replacement worker did not reach running state after resume.',
        );
        const replacementIdentity = versionIdentity(runningReplacement, extensionId);
        await resumeRecoveryWakeups();
        recoveryPaused = false;
        completed = true;
        return Object.freeze({
          stopped: Object.freeze({ ...oldIdentity, attachmentId: attached.attachmentId, runningStatus: 'stopped' }),
          replacement: Object.freeze({ ...replacementIdentity, attachmentId: attached.attachmentId, runningStatus: 'running' }),
          lifecycle: Object.freeze({
            mode: 'paused_target_auto_attached',
            stopCommandOrdinal: autoStopCommandOrdinal,
            stoppedOrdinal: stopped.sequence,
            installCompletedOrdinal,
            startCommandOrdinal,
            runningOrdinal: runningReplacement.sequence,
          }),
          installedClient,
          getRuntimeDiagnostics() {
            const total = Math.max(0, attached.monitor.count - attached.runtimeErrorBaseline);
            return Object.freeze({
              count: Math.min(total, MAX_RUNTIME_ERROR_EVENTS),
              overflow: total > MAX_RUNTIME_ERROR_EVENTS,
            });
          },
        });
      }
      await serviceWorkerClient.send('ServiceWorker.stopWorker', { versionId: oldIdentity.versionId });
      const stopped = await waitUntil(
        () => transitions.get(oldIdentity.versionId)?.find((version) => matchesIdentityAfter(
          version,
          oldIdentity,
          stopCommandOrdinal,
          'stopped',
          extensionId,
        )),
        timeoutMs,
        'The exact old service-worker identity did not report a current stopped transition.',
      );

      const preinstalled = await preinstallStoppedClient(oldIdentity);
      if (
        !preinstalled
        || !preinstalled.client
        || !preinstalled.installedClient
        || typeof preinstalled.attachmentId !== 'string'
      ) {
        throw new Error('Stopped target provider preinstallation returned invalid evidence.');
      }
      installedClient = preinstalled.installedClient;
      const attachmentId = boundedIdentity(preinstalled.attachmentId, 'stopped target attachment ID');
      const monitor = runtimeMonitorFor(preinstalled.client);
      const runtimeErrorBaseline = monitor.count;

      const installCompletedOrdinal = versionSequence;
      const latestStopped = versions.get(oldIdentity.versionId);
      const prematureStart = transitions.get(oldIdentity.versionId)?.some((version) => (
        version.sequence > stopped.sequence
        && version.sequence <= installCompletedOrdinal
        && (version.runningStatus === 'starting' || version.runningStatus === 'running')
      ));
      if (prematureStart) {
        throw new Error('Stopped target restarted before provider installation completed.');
      }
      if (
        !latestStopped
        || latestStopped.registrationId !== oldIdentity.registrationId
        || latestStopped.versionId !== oldIdentity.versionId
        || latestStopped.targetId !== oldIdentity.targetId
        || latestStopped.runningStatus !== 'stopped'
        || extensionScriptRoute(latestStopped.scriptURL, extensionId) !== oldIdentity.route
      ) {
        throw new Error('Stopped target identity or status changed before provider installation completed.');
      }

      const startCommandOrdinal = versionSequence;
      await serviceWorkerClient.send('ServiceWorker.startWorker', {
        scopeURL: `chrome-extension://${extensionId}/`,
      });
      await preinstalled.client.send('Runtime.runIfWaitingForDebugger');
      await waitUntil(
        () => transitions.get(oldIdentity.versionId)?.find((version) => (
          version.sequence > startCommandOrdinal
          && version.registrationId === oldIdentity.registrationId
          && version.versionId === oldIdentity.versionId
          && version.targetId === oldIdentity.targetId
          && (version.runningStatus === 'starting' || version.runningStatus === 'running')
          && extensionScriptRoute(version.scriptURL, extensionId) === oldIdentity.route
        )),
        timeoutMs,
        'The preinstalled stopped target did not report a post-start transition.',
      );
      const runningReplacement = await waitUntil(
        () => {
          const running = runningExtensionVersions(versions, extensionId);
          if (running.length > 1) throw new Error('Multiple matching extension service workers are running.');
          if (running.length === 0) return null;
          if (
            running[0].registrationId !== oldIdentity.registrationId
            || running[0].versionId !== oldIdentity.versionId
            || running[0].targetId !== oldIdentity.targetId
            || extensionScriptRoute(running[0].scriptURL, extensionId) !== oldIdentity.route
          ) {
            throw new Error('Chrome started an uninstrumented replacement target.');
          }
          return running[0];
        },
        timeoutMs,
        'The preinstalled replacement worker did not reach running state.',
      );
      const replacementIdentity = versionIdentity(runningReplacement, extensionId);
      await resumeRecoveryWakeups();
      recoveryPaused = false;
      completed = true;
      return Object.freeze({
        stopped: Object.freeze({ ...oldIdentity, attachmentId, runningStatus: 'stopped' }),
        replacement: Object.freeze({ ...replacementIdentity, attachmentId, runningStatus: 'running' }),
        lifecycle: Object.freeze({
          mode: 'stopped_target_preinstalled',
          stopCommandOrdinal,
          stoppedOrdinal: stopped.sequence,
          installCompletedOrdinal,
          startCommandOrdinal,
          runningOrdinal: runningReplacement.sequence,
        }),
        installedClient,
        getRuntimeDiagnostics() {
          const total = Math.max(0, monitor.count - runtimeErrorBaseline);
          return Object.freeze({
            count: Math.min(total, MAX_RUNTIME_ERROR_EVENTS),
            overflow: total > MAX_RUNTIME_ERROR_EVENTS,
          });
        },
      });
    } finally {
      if (!completed && installedClient) await retireReplacementClient(installedClient).catch(() => {});
      if (!completed) removeRuntimeMonitor();
      if (!completed) await closeAutoAttach().catch(() => {});
      if (recoveryPaused) await resumeRecoveryWakeups().catch(() => {});
      replacing = false;
    }
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    removeRuntimeMonitor();
    await closeAutoAttach();
    if (typeof serviceWorkerClient.off === 'function') {
      serviceWorkerClient.off('ServiceWorker.workerVersionUpdated', onVersionUpdated);
    } else {
      serviceWorkerClient.removeListener?.('ServiceWorker.workerVersionUpdated', onVersionUpdated);
    }
    await serviceWorkerClient.send('ServiceWorker.disable').catch(() => {});
    await serviceWorkerClient.detach().catch(() => {});
  };

  return Object.freeze({ replace, close });
}

function matchesIdentityAfter(version, identity, sequence, status, extensionId) {
  return version.sequence > sequence
    && version.registrationId === identity.registrationId
    && version.versionId === identity.versionId
    && version.targetId === identity.targetId
    && version.runningStatus === status
    && extensionScriptRoute(version.scriptURL, extensionId) === identity.route;
}

function runningExtensionVersions(versions, extensionId) {
  return [...versions.values()].filter((version) => (
    isExtensionScript(version.scriptURL, extensionId)
    && version.runningStatus === 'running'
  ));
}

function singleRunningExtensionVersion(versions, extensionId) {
  const matches = runningExtensionVersions(versions, extensionId);
  if (matches.length > 1) throw new Error('Multiple matching extension service workers are running.');
  return matches[0] ?? null;
}

function versionIdentity(version, extensionId) {
  return Object.freeze({
    versionId: boundedIdentity(version.versionId, 'service-worker version ID'),
    registrationId: boundedIdentity(version.registrationId, 'service-worker registration ID'),
    targetId: boundedIdentity(version.targetId, 'service-worker target ID'),
    route: extensionScriptRoute(version.scriptURL, extensionId),
  });
}

function isExtensionScript(value, extensionId) {
  return typeof value === 'string' && value.startsWith(`chrome-extension://${extensionId}/`);
}

function extensionScriptRoute(value, extensionId) {
  const url = new URL(String(value));
  if (url.protocol !== 'chrome-extension:' || url.hostname !== extensionId || url.search || url.hash) {
    throw new Error('Service-worker script identity is outside the packaged extension.');
  }
  if (!/^\/[A-Za-z0-9._/-]{1,159}$/u.test(url.pathname)) {
    throw new Error('Service-worker script route is invalid.');
  }
  return url.pathname;
}

function boundedIdentity(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_IDENTITY_LENGTH) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function assertPositiveTimeout(value) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('Worker replacement timeout must be positive.');
}
