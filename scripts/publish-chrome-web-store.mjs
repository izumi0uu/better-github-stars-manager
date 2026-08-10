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
} = {}) {
  assertRequiredEnvironment(env);
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

  assertSuccessfulUpload(upload, {
    extensionId: env.CWS_EXTENSION_ID,
    resourcePath,
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
    uploadState: upload.uploadState,
    itemId: upload.itemId,
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

function assertSuccessfulUpload(upload, { extensionId, resourcePath }) {
  if (!isRecord(upload) || upload.uploadState !== UPLOAD_STATE_SUCCEEDED) {
    const state = isRecord(upload) ? upload.uploadState ?? 'missing' : 'missing';
    throw new Error(`upload failed with state ${state}`);
  }

  if (upload.itemId !== extensionId) {
    throw new Error('upload failed: itemId does not match configured extension ID');
  }
  if (upload.name !== resourcePath) {
    throw new Error('upload failed: name does not match configured extension resource');
  }
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
    if (!env?.[key]) throw new Error(`missing required env: ${key}`);
  }
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
