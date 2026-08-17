import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  FIREFOX_GECKO_ID,
  FIREFOX_TEST_UUID,
} from '../../scripts/build-firefox-extension.mjs';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_MS = 100;
const MAX_DIAGNOSTIC_ITEMS = 24;
const FIREFOX_BACKGROUND_PAGE_PATH = '/_generated_background_page.html';
const FIREFOX_DISCOVERY_PAGE_PATH = '/src/popup/index.html';

const MAX_LABEL_LENGTH = 160;

export function normalizeRuntimeTarget(target = 'chrome') {
  if (target !== 'chrome' && target !== 'edge' && target !== 'firefox') {
    throw new TypeError(`Unsupported runtime target: ${String(target)}.`);
  }
  return target;
}

export function extensionOrigin(extensionId, target = 'chrome') {
  const normalizedTarget = normalizeRuntimeTarget(target);
  if (normalizedTarget === 'firefox') {
    if (extensionId !== FIREFOX_GECKO_ID && extensionId !== FIREFOX_TEST_UUID) {
      throw new TypeError('Firefox extensionId must be the fixed Gecko ID or test UUID.');
    }
    return `moz-extension://${FIREFOX_TEST_UUID}`;
  }
  if (typeof extensionId !== 'string' || !/^[a-z]{32}$/.test(extensionId)) {
    throw new TypeError('extensionId must be a 32-character Chrome extension ID.');
  }
  return `chrome-extension://${extensionId}`;
}

export function extensionUrl(extensionId, pagePath, target = 'chrome') {
  return `${extensionOrigin(extensionId, target)}${normalizePagePath(pagePath)}`;
}

export function resolvePackagedServiceWorker(dist, { target = 'chrome' } = {}) {
  const normalizedTarget = normalizeRuntimeTarget(target);
  const requestedRoot = path.resolve(dist);
  if (!existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory()) {
    throw new Error('Packaged extension directory is unavailable.');
  }
  const distRoot = realpathSync(requestedRoot);
  const manifestPath = path.join(distRoot, 'manifest.json');
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error('Packaged extension manifest is unavailable.');
  }
  const manifestBytes = readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('Packaged extension manifest is invalid.');
  }
  const workerRelativePath = normalizedTarget === 'firefox'
    ? manifest?.background?.scripts?.[0]
    : manifest?.background?.service_worker;
  if (typeof workerRelativePath !== 'string' || workerRelativePath.length === 0) {
    throw new Error(`Packaged ${normalizedTarget} extension manifest has no background loader.`);
  }
  const requestedWorkerPath = path.resolve(distRoot, workerRelativePath);
  const requestedRelativePath = path.relative(distRoot, requestedWorkerPath);
  if (
    requestedRelativePath === ''
    || requestedRelativePath.startsWith(`..${path.sep}`)
    || requestedRelativePath === '..'
    || path.isAbsolute(requestedRelativePath)
  ) {
    throw new Error('Packaged background loader escapes the extension directory.');
  }
  if (!existsSync(requestedWorkerPath) || !statSync(requestedWorkerPath).isFile()) {
    throw new Error('Packaged background loader is unavailable.');
  }
  const workerPath = realpathSync(requestedWorkerPath);
  const containedRelativePath = path.relative(distRoot, workerPath);
  if (
    containedRelativePath.startsWith(`..${path.sep}`)
    || containedRelativePath === '..'
    || path.isAbsolute(containedRelativePath)
  ) {
    throw new Error('Packaged background loader resolves outside the extension directory.');
  }
  return Object.freeze({
    distRoot,
    manifestBytes,
    manifestPath,
    workerPath,
    workerRelativePath: containedRelativePath.split(path.sep).join('/'),
    backgroundKind: normalizedTarget === 'firefox' ? 'event_page' : 'service_worker',
  });
}

export async function discoverExtension(browser, {
  target = 'chrome',
  dist,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = 250,
  openPage = null,
} = {}) {
  const normalizedTarget = normalizeRuntimeTarget(target);
  if (!browser) {
    throw new TypeError('browser must expose Puppeteer extension discovery.');
  }
  if (openPage !== null && typeof openPage !== 'function') {
    throw new TypeError('openPage must be a function when provided.');
  }
  if (normalizedTarget === 'firefox') {
    if (openPage === null && typeof browser.newPage !== 'function') {
      throw new TypeError('Firefox browser must create an extension control page.');
    }
  } else if (typeof browser.targets !== 'function' || typeof browser.extensions !== 'function') {
    throw new TypeError(`${normalizedTarget === 'edge' ? 'Edge' : 'Chrome'} browser must expose Puppeteer extension discovery.`);
  }
  assertPositiveTimeout(timeoutMs, 'timeoutMs');
  assertPositiveTimeout(pollMs, 'pollMs');

  if (normalizedTarget === 'firefox') {
    const expectedPageUrl = extensionUrl(
      FIREFOX_GECKO_ID,
      FIREFOX_DISCOVERY_PAGE_PATH,
      'firefox',
    );
    const controlPage = openPage
      ? await openPage(expectedPageUrl, { timeoutMs, readyTimeoutMs: timeoutMs })
      : await browser.newPage();
    const expectedBackgroundUrl = extensionUrl(
      FIREFOX_GECKO_ID,
      FIREFOX_BACKGROUND_PAGE_PATH,
      'firefox',
    );
    let stage = 'waiting for extension page readiness';
    try {
      if (openPage) {
        await waitForExtensionPageReady(controlPage, expectedPageUrl, {
          readyTimeoutMs: timeoutMs,
          rootSelector: '#root',
        });
      } else {
        await navigateExtensionPage(controlPage, expectedPageUrl, {
          target: 'firefox',
          timeoutMs,
          readyTimeoutMs: timeoutMs,
          rootSelector: '#root',
        });
      }
      stage = 'reading extension identity';
      const identity = await controlPage.evaluate(async () => {
        const backgroundPage = await chrome.runtime.getBackgroundPage();
        return {
          runtimeId: chrome.runtime.id,
          backgroundUrl: backgroundPage?.location.href ?? null,
        };
      });
      stage = 'validating extension identity';
      if (
        identity.runtimeId !== FIREFOX_GECKO_ID
        || identity.backgroundUrl !== expectedBackgroundUrl
      ) {
        throw new Error(
          `Firefox extension identity mismatch: ${boundedLabel(identity.runtimeId)} / ${boundedLabel(identity.backgroundUrl)}`,
        );
      }
      return Object.freeze({
        extensionId: FIREFOX_GECKO_ID,
        extId: FIREFOX_GECKO_ID,
        extension: null,
        target: null,
        worker: controlPage,
        backgroundPage: null,
        controlPage,
        backgroundKind: 'event_page',
      });
    } catch (error) {
      await controlPage.close().catch(() => {});
      throw new Error(
        `Packaged Firefox background did not become ready before the discovery timeout. Last state: ${stage}: ${boundedLabel(error instanceof Error ? error.message : error)}`,
      );
    }
  }

  const expectedDist = dist ? path.resolve(dist) : null;
  const deadline = Date.now() + timeoutMs;
  let lastDiagnostic = 'no background runtime data';
  while (Date.now() < deadline) {
    const extensions = await browser.extensions().catch(() => null);
    const candidates = [...(extensions?.values?.() ?? [])];
    const extension = candidates.find((candidate) => (
      candidate.enabled === true
      && (!expectedDist || path.resolve(candidate.path) === expectedDist)
    ));
    const background = extension ? await findChromiumBackgroundRuntime(browser, extension, normalizedTarget) : null;
    if (extension && background) {
      const runtimeId = await background.executionContext
        .evaluate(() => chrome.runtime.id)
        .catch(() => null);
      if (runtimeId === extension.id) {
        return Object.freeze({
          extensionId: extension.id,
          extId: extension.id,
          extension,
          target: background.target,
          worker: background.executionContext,
          backgroundPage: null,
          controlPage: null,
          backgroundKind: 'service_worker',
        });
      }
      lastDiagnostic = `${normalizedTarget === 'edge' ? 'Edge' : 'Chrome'} service worker returned unexpected extension ID: ${boundedLabel(runtimeId)}`;
    } else {
      lastDiagnostic = JSON.stringify(candidates.slice(0, MAX_DIAGNOSTIC_ITEMS).map((candidate) => ({
        id: boundedLabel(candidate.id),
        enabled: candidate.enabled === true,
        pathMatches: Boolean(expectedDist && candidate.path && path.resolve(candidate.path) === expectedDist),
      })));
    }
    await delay(pollMs);
  }
  throw new Error(
    `Packaged ${normalizedTarget === 'edge' ? 'Edge' : 'Chrome'} background did not become ready before the discovery timeout. Last state: ${lastDiagnostic}`,
  );
}

export async function openExtensionPage(browser, extensionId, pagePath = '/src/options/index.html', label = pagePath, {
  target = 'chrome',
  timeoutMs = 30_000,
  readyTimeoutMs = 10_000,
  rootSelector = '#root',
  failClosedHttp = null,
  beforeNavigation = null,
  openPage = null,
} = {}) {
  const normalizedTarget = normalizeRuntimeTarget(target);
  if (!browser || (openPage === null && typeof browser.newPage !== 'function')) {
    throw new TypeError('browser must create Puppeteer pages.');
  }
  const normalizedPath = normalizePagePath(pagePath);
  const safeLabel = boundedLabel(label, 'extension-page');
  assertPositiveTimeout(timeoutMs, 'timeoutMs');
  assertPositiveTimeout(readyTimeoutMs, 'readyTimeoutMs');
  if (beforeNavigation !== null && typeof beforeNavigation !== 'function') {
    throw new TypeError('beforeNavigation must be a function when provided.');
  }
  if (openPage !== null && typeof openPage !== 'function') {
    throw new TypeError('openPage must be a function when provided.');
  }

  const expectedUrl = extensionUrl(extensionId, normalizedPath, normalizedTarget);
  const page = openPage
    ? await openPage(expectedUrl, { timeoutMs, readyTimeoutMs })
    : await browser.newPage();
  let pageHttpPolicy = null;
  try {
    pageHttpPolicy = await installFailClosedPageHttpPolicy(page, failClosedHttp);
    await beforeNavigation?.(page);
    if (openPage) {
      await waitForExtensionPageReady(page, expectedUrl, { readyTimeoutMs, rootSelector });
    } else {
      await navigateExtensionPage(page, expectedUrl, {
        target: normalizedTarget,
        timeoutMs,
        readyTimeoutMs,
        rootSelector,
      });
    }
    return page;
  } catch {
    await pageHttpPolicy?.close();
    await page.close().catch(() => {});
    throw new Error(`Packaged extension page ${safeLabel} did not become ready before its timeout.`);
  }
}
async function navigateExtensionPage(page, expectedUrl, {
  target,
  timeoutMs,
  readyTimeoutMs,
  rootSelector,
}) {
  let navigationError = null;
  try {
    await page.goto(expectedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: target === 'firefox' ? Math.min(timeoutMs, 1_000) : timeoutMs,
    });
  } catch (error) {
    navigationError = error;
    if (target !== 'firefox') throw error;
  }
  try {
    await waitForExtensionPageReady(page, expectedUrl, { readyTimeoutMs, rootSelector });
  } catch (error) {
    throw navigationError ?? error;
  }
}

async function waitForExtensionPageReady(page, expectedUrl, {
  readyTimeoutMs,
  rootSelector,
}) {
  await page.waitForFunction(
    (expected, selector) => (
      location.href === expected
      && document.readyState !== 'loading'
      && (!selector || document.querySelector(selector) !== null)
    ),
    { polling: DEFAULT_POLL_MS, timeout: readyTimeoutMs },
    expectedUrl,
    rootSelector,
  );
}

export async function openHttpFixturePage(browser, url, label = 'http-fixture-page', {
  timeoutMs = 30_000,
  readyTimeoutMs = 10_000,
  rootSelector = 'main',
  failClosedHttp,
} = {}) {
  if (!browser || typeof browser.newPage !== 'function') {
    throw new TypeError('browser must create Puppeteer pages.');
  }
  const expectedUrl = String(url);
  if (!isHttpUrl(expectedUrl)) throw new TypeError('HTTP fixture page URL must use HTTP(S).');
  const safeLabel = boundedLabel(label, 'http-fixture-page');
  assertPositiveTimeout(timeoutMs, 'timeoutMs');
  assertPositiveTimeout(readyTimeoutMs, 'readyTimeoutMs');

  const page = await browser.newPage();
  let pageHttpPolicy = null;
  try {
    pageHttpPolicy = await installFailClosedPageHttpPolicy(page, failClosedHttp, { expectedDocumentUrl: expectedUrl });
    await page.goto(expectedUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForFunction(
      (expected, selector) => (
        location.href === expected
        && document.readyState !== 'loading'
        && (!selector || document.querySelector(selector) !== null)
      ),
      { polling: DEFAULT_POLL_MS, timeout: readyTimeoutMs },
      expectedUrl,
      rootSelector,
    );
    return page;
  } catch {
    await pageHttpPolicy?.close();
    await page.close().catch(() => {});
    throw new Error(`Packaged HTTP fixture page ${safeLabel} did not become ready before its timeout.`);
  }
}
async function findChromiumBackgroundRuntime(browser, extension, target) {
  const extensionBaseUrl = extensionOrigin(extension.id, target);
  const backgroundTarget = browser.targets().find((candidate) => (
    candidate.type() === 'service_worker'
    && candidate.url().startsWith(`${extensionBaseUrl}/`)
  ));
  if (!backgroundTarget) return null;
  const executionContext = await backgroundTarget.worker().catch(() => null);
  return executionContext ? { target: backgroundTarget, executionContext, backgroundPage: null } : null;
}




/** Collect bounded semantic page failures without retaining page error text. */
export function hookPageDiagnostics(page, label = 'extension-page', { issues = [] } = {}) {
  if (!page || typeof page.on !== 'function') throw new TypeError('page must expose event listeners.');
  const safeLabel = boundedLabel(label, 'extension-page');
  const record = (kind, value = null) => {
    if (issues.length >= MAX_DIAGNOSTIC_ITEMS) return;
    issues.push(Object.freeze({
      label: safeLabel,
      kind: boundedLabel(kind, 'page-issue'),
      ...(value === null ? {} : { value: redactLabel(value) }),
    }));
  };
  const onConsole = (message) => {
    if (message.type?.() !== 'error') return;
    const rawUrl = message.location?.()?.url ?? '';
    const text = message.text?.() ?? '';
    const safeRoute = isHttpUrl(rawUrl)
      ? classifySafeHttpRoute(rawUrl)
      : /notifications/iu.test(text) ? 'github-notifications' : null;
    record('console-error', safeRoute);
  };
  const onPageError = () => record('page-error');
  const onRequestFailed = (request) => {
    const rawUrl = request.url?.() ?? '';
    const method = normalizeMethod(request.method?.());
    const failure = request.failure?.()?.errorText ?? '';
    const isExtensionResource = /^(?:chrome|moz)-extension:\/\//iu.test(rawUrl);
    if (
      failure === 'net::ERR_ABORTED'
      && (request.isNavigationRequest?.() === true || isExtensionResource)
    ) return;
    if (/^(?:data|blob|about):/iu.test(rawUrl)) return;
    if (isExtensionResource) {
      record('request-failed', `${method} extension-resource`);
      return;
    }
    record(
      'request-failed',
      `${method} ${isHttpUrl(rawUrl) ? classifySafeHttpRoute(rawUrl) : 'non-http-resource'}`,
    );
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);
  return Object.freeze({
    issues,
    cleanup() {
      for (const [event, listener] of [
        ['console', onConsole],
        ['pageerror', onPageError],
        ['requestfailed', onRequestFailed],
      ]) {
        if (typeof page.off === 'function') page.off(event, listener);
        else page.removeListener?.(event, listener);
      }
    },
  });
}

async function installFailClosedPageHttpPolicy(page, input, { expectedDocumentUrl = null } = {}) {
  if (input === null || input === undefined) return null;
  if (!input || typeof input !== 'object' || !Array.isArray(input.unexpectedRequests)) {
    throw new TypeError('failClosedHttp must provide an unexpectedRequests array.');
  }
  if (input.expectedRequests !== undefined && !Array.isArray(input.expectedRequests)) {
    throw new TypeError('failClosedHttp expectedRequests must be an array when provided.');
  }
  input.expectedRequests ??= [];
  input.overflow = input.overflow === true;
  input.interceptionFailure = input.interceptionFailure === true;
  input.closed = false;
  const fixtureHandler = typeof input.handler === 'function' ? input.handler : null;
  const pending = new Set();
  let active = true;
  const track = (operation) => {
    let tracked;
    tracked = Promise.resolve()
      .then(operation)
      .catch(() => { input.interceptionFailure = true; })
      .finally(() => pending.delete(tracked));
    pending.add(tracked);
  };
  const appendRecord = (records, record) => {
    if (records.length >= MAX_DIAGNOSTIC_ITEMS) input.overflow = true;
    else records.push(Object.freeze(record));
  };
  const onRequest = (request) => {
    const rawUrl = request.url?.() ?? '';
    if (!isHttpUrl(rawUrl)) {
      track(() => request.continue());
      return;
    }
    const descriptor = Object.freeze({
      method: normalizeMethod(request.method?.()),
      route: classifySafeHttpRoute(rawUrl),
      resourceType: normalizePageResourceType(request.resourceType?.()),
    });
    const unexpectedDocument = descriptor.resourceType === 'document'
      && expectedDocumentUrl !== null
      && rawUrl !== expectedDocumentUrl;
    track(async () => {
      try {
        const outcome = unexpectedDocument ? null : fixtureHandler ? await fixtureHandler(descriptor) : null;
        if (!outcome) {
          appendRecord(input.unexpectedRequests, descriptor);
          await request.abort('failed');
          return;
        }
        const response = normalizePageFixtureResponse(outcome);
        appendRecord(input.expectedRequests, { ...descriptor, status: response.status });
        await request.respond(response);
      } catch {
        input.interceptionFailure = true;
        await request.abort('failed').catch(() => {});
      }
    });
  };
  page.on('request', onRequest);
  await page.setRequestInterception(true);
  input.close = async () => {
    if (!active) return;
    active = false;
    if (typeof page.off === 'function') page.off('request', onRequest);
    else page.removeListener?.('request', onRequest);
    await Promise.allSettled([...pending]);
    if (!page.isClosed?.()) {
      await page.setRequestInterception(false).catch((error) => {
        if (!page.isClosed?.()) throw error;
      });
    }
    input.closed = true;
  };
  return input;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function classifySafeHttpRoute(value) {
  try {
    const url = new URL(String(value));
    if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses') return 'responses';
    if (url.origin === 'https://api.github.com' && url.pathname === '/user') return 'github-user';
    if (url.origin === 'https://api.github.com' && url.pathname === '/user/starred') return 'github-starred';
    if (url.origin === 'https://api.github.com' && url.pathname === '/user/subscriptions') return 'github-watch-scope';
    if (url.origin === 'https://api.github.com' && url.pathname === '/notifications') return 'github-notifications';
    if (url.origin === 'https://api.github.com' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/u.test(url.pathname)) return 'github-watch-subject';
    if (url.origin === 'https://api.github.com' && url.pathname === '/gists/runtime-probe-gist') return 'github-probe-gist';
    if (url.origin === 'https://api.github.com' && url.pathname.startsWith('/gists')) return 'github-gists';
    if (url.origin === 'https://avatars.githubusercontent.com') return 'github-avatar';
    if (url.origin === 'https://github.com') return 'github-web';
    if (url.origin === 'https://gist.github.com') return 'github-gist-web';
  } catch {
    return 'unknown-http-route';
  }
  return 'unknown-http-route';
}

function normalizePageResourceType(value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  return [
    'document',
    'stylesheet',
    'image',
    'media',
    'font',
    'script',
    'texttrack',
    'xhr',
    'fetch',
    'prefetch',
    'eventsource',
    'websocket',
    'manifest',
    'signedexchange',
    'ping',
    'cspviolationreport',
    'preflight',
    'other',
  ].includes(normalized) ? normalized : 'other';
}

function normalizePageFixtureResponse(outcome) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new TypeError('Page HTTP fixture must return a response object.');
  }
  const status = Number(outcome.status);
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    throw new RangeError('Page HTTP fixture status must be between 100 and 599.');
  }
  if (typeof outcome.body !== 'string') throw new TypeError('Page HTTP fixture body must be a string.');
  const headers = {};
  if (outcome.contentType !== undefined) headers['content-type'] = normalizeHeaderValue(outcome.contentType);
  if (outcome.headers !== undefined) {
    if (!outcome.headers || typeof outcome.headers !== 'object' || Array.isArray(outcome.headers)) {
      throw new TypeError('Page HTTP fixture headers must be an object.');
    }
    for (const [name, value] of Object.entries(outcome.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        throw new TypeError('Page HTTP fixture header name is invalid.');
      }
      headers[name.toLowerCase()] = normalizeHeaderValue(value);
    }
  }
  if (status === 204 || status === 304) {
    if (outcome.body.length > 0) throw new TypeError('Bodyless Page HTTP fixture status cannot include a body.');
    return { status, headers };
  }
  return { status, headers, body: outcome.body };
}

function normalizeHeaderValue(value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    throw new TypeError('Page HTTP fixture header value is invalid.');
  }
  return value;
}

function boundedLabel(value, fallback = 'unknown') {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_LABEL_LENGTH) || fallback;
}

function redactLabel(value) {
  return boundedLabel(value).replace(
    /(bearer|token|secret|password|api[-_ ]?key|credential)[^\s:=]*[\s:=]+[^\s,;)}]+/gi,
    '$1=[redacted]',
  );
}



function normalizePagePath(pagePath) {
  if (typeof pagePath !== 'string' || !pagePath.startsWith('/')) {
    throw new TypeError('pagePath must be an absolute extension path.');
  }
  return pagePath;
}

function normalizeMethod(value) {
  const method = typeof value === 'string' ? value.toUpperCase() : 'UNKNOWN';
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'UNKNOWN';
}

function assertPositiveTimeout(value, field) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be a positive number.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
