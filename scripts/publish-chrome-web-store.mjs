#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_ENV = Object.freeze([
  'CWS_CLIENT_ID',
  'CWS_CLIENT_SECRET',
  'CWS_REFRESH_TOKEN',
  'CWS_EXTENSION_ID',
  'CWS_PUBLISHER_ID',
]);
const DEFAULT_UPLOAD_POLL_INTERVAL_MS = 5_000;
const DEFAULT_UPLOAD_POLL_TIMEOUT_MS = 5 * 60_000;
const UPLOAD_STATE_IN_PROGRESS = 'IN_PROGRESS';
const UPLOAD_STATE_SUCCEEDED = 'SUCCEEDED';
const SUCCESSFUL_PUBLISH_STATES_BY_TYPE = Object.freeze({
  DEFAULT_PUBLISH: Object.freeze([
    'PENDING_REVIEW',
    'PUBLISHED',
    'PUBLISHED_TO_TESTERS',
  ]),
  STAGED_PUBLISH: Object.freeze([
    'PENDING_REVIEW',
    'STAGED',
  ]),
});

export async function publishChromeWebStore({
  zipPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
  sleep = delay,
  uploadPollIntervalMs = DEFAULT_UPLOAD_POLL_INTERVAL_MS,
  uploadPollTimeoutMs = DEFAULT_UPLOAD_POLL_TIMEOUT_MS,
} = {}) {
  assertRequiredEnvironment(env);
  assertUploadPollingOptions({ uploadPollIntervalMs, uploadPollTimeoutMs });
  const publishType = env.CWS_PUBLISH_TYPE || 'DEFAULT_PUBLISH';
  if (!Object.hasOwn(SUCCESSFUL_PUBLISH_STATES_BY_TYPE, publishType)) {
    throw new Error(`unsupported Chrome Web Store publish type: ${publishType}`);
  }
  const skipReview = env.CWS_SKIP_REVIEW === '1';

  const accessToken = await fetchAccessToken({ env, fetchImpl });
  const resourcePath =
    `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}`;

  const upload = await apiFetch(
    `https://chromewebstore.googleapis.com/upload/v2/${resourcePath}:upload`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
      },
      body: readFileSync(zipPath),
    },
    accessToken,
    fetchImpl,
  );

  const completedUpload = await awaitSuccessfulUpload({
    upload,
    accessToken,
    extensionId: env.CWS_EXTENSION_ID,
    resourcePath,
    fetchImpl,
    sleep,
    uploadPollIntervalMs,
    uploadPollTimeoutMs,
  });

  const publish = await apiFetch(
    `https://chromewebstore.googleapis.com/v2/${resourcePath}:publish`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        publishType,
        skipReview,
      }),
    },
    accessToken,
    fetchImpl,
  );
  assertSuccessfulPublish(publish, {
    extensionId: env.CWS_EXTENSION_ID,
    publishType,
    resourcePath,
  });

  const output = {
    uploadState: completedUpload.uploadState,
    itemId: completedUpload.itemId,
    published: {
      name: publish.name,
      itemId: publish.itemId,
      state: publish.state,
    },
  };
  log(JSON.stringify(output, null, 2));
  return output;
}

async function fetchAccessToken({ env, fetchImpl }) {
  const body = new URLSearchParams({
    client_id: env.CWS_CLIENT_ID,
    client_secret: env.CWS_CLIENT_SECRET,
    refresh_token: env.CWS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });

  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`oauth token exchange failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  if (!json.access_token) throw new Error('oauth token exchange returned no access_token');
  return json.access_token;
}

async function apiFetch(url, init, accessToken, fetchImpl) {
  const res = await fetchImpl(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Chrome Web Store API failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

async function awaitSuccessfulUpload({
  upload,
  accessToken,
  extensionId,
  resourcePath,
  fetchImpl,
  sleep,
  uploadPollIntervalMs,
  uploadPollTimeoutMs,
}) {
  let state = assertUploadResponse(upload, {
    extensionId,
    resourcePath,
    stateKey: 'uploadState',
  });
  if (state === UPLOAD_STATE_SUCCEEDED) return upload;
  if (state !== UPLOAD_STATE_IN_PROGRESS) {
    throw new Error(`upload failed with state ${state}`);
  }

  const maxPollAttempts = Math.floor(uploadPollTimeoutMs / uploadPollIntervalMs);
  const statusUrl =
    `https://chromewebstore.googleapis.com/v2/${resourcePath}:fetchStatus`;

  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    await sleep(uploadPollIntervalMs);
    const status = await apiFetch(
      statusUrl,
      { method: 'GET' },
      accessToken,
      fetchImpl,
    );
    state = assertUploadResponse(status, {
      extensionId,
      resourcePath,
      stateKey: 'lastAsyncUploadState',
    });
    if (state === UPLOAD_STATE_SUCCEEDED) {
      return {
        name: status.name,
        itemId: status.itemId,
        uploadState: state,
      };
    }
    if (state !== UPLOAD_STATE_IN_PROGRESS) {
      throw new Error(`upload failed with state ${state}`);
    }
  }

  throw new Error(`upload timed out after ${uploadPollTimeoutMs}ms`);
}

function assertUploadResponse(response, { extensionId, resourcePath, stateKey }) {
  if (!isRecord(response)) throw new Error('upload failed with state missing');
  if (response.itemId !== extensionId) {
    throw new Error('upload failed: itemId does not match configured extension ID');
  }
  if (response.name !== resourcePath) {
    throw new Error('upload failed: name does not match configured extension resource');
  }

  return response[stateKey] ?? 'missing';
}

function assertSuccessfulPublish(publish, { extensionId, publishType, resourcePath }) {
  const successfulStates = SUCCESSFUL_PUBLISH_STATES_BY_TYPE[publishType];
  if (!isRecord(publish) || !successfulStates.includes(publish.state)) {
    const state = isRecord(publish) ? publish.state ?? 'missing' : 'missing';
    throw new Error(`publish failed with state ${state}`);
  }

  if (publish.itemId !== extensionId) {
    throw new Error('publish failed: itemId does not match configured extension ID');
  }
  if (publish.name !== resourcePath) {
    throw new Error('publish failed: name does not match configured extension resource');
  }
}

function assertRequiredEnvironment(env) {
  for (const key of REQUIRED_ENV) {
    const value = env?.[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`missing required env: ${key}`);
    }
  }
}

function assertUploadPollingOptions({ uploadPollIntervalMs, uploadPollTimeoutMs }) {
  if (!Number.isFinite(uploadPollIntervalMs) || uploadPollIntervalMs <= 0) {
    throw new Error('upload poll interval must be a positive finite number');
  }
  if (
    !Number.isFinite(uploadPollTimeoutMs)
    || uploadPollTimeoutMs < uploadPollIntervalMs
  ) {
    throw new Error('upload poll timeout must be finite and at least one interval');
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function main() {
  const zipArg = process.argv[2];
  const zipPath = zipArg ? path.resolve(process.cwd(), zipArg) : null;

  if (!zipPath || !existsSync(zipPath)) {
    console.error('❌ Usage: node scripts/publish-chrome-web-store.mjs <path-to-extension-zip>');
    process.exit(1);
  }

  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      console.error(`❌ Missing required env: ${key}`);
      process.exit(1);
    }
  }

  await publishChromeWebStore({ zipPath });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
