import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { publishChromeWebStore } from '../../scripts/publish-chrome-web-store.mjs';

const ACCESS_TOKEN = 'returned-access-token';
const BASE_ENV = Object.freeze({
  CWS_CLIENT_ID: 'test-client-id',
  CWS_CLIENT_SECRET: 'client-secret-must-not-be-logged',
  CWS_REFRESH_TOKEN: 'refresh-token-must-not-be-logged',
  CWS_EXTENSION_ID: 'test-extension-id',
  CWS_PUBLISHER_ID: 'test-publisher-id',
});
const RESOURCE_PATH = `publishers/${BASE_ENV.CWS_PUBLISHER_ID}/items/${BASE_ENV.CWS_EXTENSION_ID}`;
const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = `https://chromewebstore.googleapis.com/upload/v2/${RESOURCE_PATH}:upload`;
const PUBLISH_URL = `https://chromewebstore.googleapis.com/v2/${RESOURCE_PATH}:publish`;
const ZIP_BYTES = Buffer.from([
  0x50, 0x4b, 0x05, 0x06,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00,
]);

function environment() {
  return { ...BASE_ENV };
}

function resourcePath(env) {
  return `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}`;
}

function successfulUpload(env, overrides = {}) {
  return {
    name: resourcePath(env),
    itemId: env.CWS_EXTENSION_ID,
    uploadState: 'SUCCEEDED',
    ...overrides,
  };
}

function successfulPublish(env, overrides = {}) {
  return {
    name: resourcePath(env),
    itemId: env.CWS_EXTENSION_ID,
    state: 'PENDING_REVIEW',
    ...overrides,
  };
}

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}

function failedResponse(status, text) {
  return {
    ok: false,
    status,
    text: async () => text,
  };
}

function createFetchSequence(responses) {
  const calls = [];
  let responseIndex = 0;

  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (responseIndex === responses.length) {
        throw new Error(`Unexpected fetch request: ${String(url)}`);
      }
      return responses[responseIndex++];
    },
  };
}

async function withTemporaryZip(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'publish-chrome-web-store-'));
  const zipPath = path.join(root, 'extension.zip');
  writeFileSync(zipPath, ZIP_BYTES);

  try {
    return await run(zipPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertNoPublishRequest(calls) {
  assert.deepEqual(calls.map(({ url }) => url), [OAUTH_URL, UPLOAD_URL]);
  assert.equal(calls.filter(({ url }) => url === PUBLISH_URL).length, 0);
}

function assertLogsOmitCredentials(logs, env) {
  const output = logs.join('\n');
  for (const credential of [
    env.CWS_CLIENT_SECRET,
    env.CWS_REFRESH_TOKEN,
    ACCESS_TOKEN,
  ]) {
    assert.equal(output.includes(credential), false);
  }
}

test('publishes an exact successful upload after OAuth without logging credentials', async () => {
  await withTemporaryZip(async (zipPath) => {
    const env = environment();
    const logs = [];
    const publishResult = successfulPublish(env);
    const { calls, fetchImpl } = createFetchSequence([
      jsonResponse({ access_token: ACCESS_TOKEN }),
      jsonResponse(successfulUpload(env)),
      jsonResponse(publishResult),
    ]);

    const result = await publishChromeWebStore({
      zipPath,
      env,
      fetchImpl,
      log: (line) => logs.push(String(line)),
    });

    assert.deepEqual(calls.map(({ url }) => url), [OAUTH_URL, UPLOAD_URL, PUBLISH_URL]);

    const [oauth, upload, publish] = calls;
    assert.equal(oauth.init.method, 'POST');
    assert.deepEqual(oauth.init.headers, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    assert.deepEqual(
      Object.fromEntries(new URLSearchParams(String(oauth.init.body))),
      {
        client_id: env.CWS_CLIENT_ID,
        client_secret: env.CWS_CLIENT_SECRET,
        refresh_token: env.CWS_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      },
    );
    assert.deepEqual(upload.init.headers, {
      'Content-Type': 'application/zip',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      Accept: 'application/json',
    });
    assert.deepEqual(upload.init.body, ZIP_BYTES);
    assert.deepEqual(publish.init.headers, {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      Accept: 'application/json',
    });
    assert.deepEqual(JSON.parse(publish.init.body), {
      publishType: 'DEFAULT_PUBLISH',
      skipReview: false,
    });
    assert.deepEqual(result, {
      uploadState: 'SUCCEEDED',
      itemId: env.CWS_EXTENSION_ID,
      published: publishResult,
    });
    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0]), result);
    assertLogsOmitCredentials(logs, env);
  });
});

test('accepts a staged response only for staged publishing', async () => {
  await withTemporaryZip(async (zipPath) => {
    const env = {
      ...environment(),
      CWS_PUBLISH_TYPE: 'STAGED_PUBLISH',
    };
    const logs = [];
    const publishResult = successfulPublish(env, { state: 'STAGED' });
    const { calls, fetchImpl } = createFetchSequence([
      jsonResponse({ access_token: ACCESS_TOKEN }),
      jsonResponse(successfulUpload(env)),
      jsonResponse(publishResult),
    ]);

    const result = await publishChromeWebStore({
      zipPath,
      env,
      fetchImpl,
      log: (line) => logs.push(String(line)),
    });

    assert.deepEqual(JSON.parse(calls[2].init.body), {
      publishType: 'STAGED_PUBLISH',
      skipReview: false,
    });
    assert.deepEqual(result.published, publishResult);
    assert.deepEqual(JSON.parse(logs[0]), result);
    assertLogsOmitCredentials(logs, env);
  });
});

test('rejects a missing upload state before publishing', async () => {
  await withTemporaryZip(async (zipPath) => {
    const env = environment();
    const logs = [];
    const { calls, fetchImpl } = createFetchSequence([
      jsonResponse({ access_token: ACCESS_TOKEN }),
      jsonResponse({
        name: resourcePath(env),
        itemId: env.CWS_EXTENSION_ID,
      }),
    ]);

    await assert.rejects(
      publishChromeWebStore({
        zipPath,
        env,
        fetchImpl,
        log: (line) => logs.push(String(line)),
      }),
      /upload failed with state missing/u,
    );

    assertNoPublishRequest(calls);
    assert.deepEqual(logs, []);
    assertLogsOmitCredentials(logs, env);
  });
});

test('rejects a successful upload without an item ID before publishing', async () => {
  await withTemporaryZip(async (zipPath) => {
    const env = environment();
    const logs = [];
    const { calls, fetchImpl } = createFetchSequence([
      jsonResponse({ access_token: ACCESS_TOKEN }),
      jsonResponse({
        name: resourcePath(env),
        uploadState: 'SUCCEEDED',
      }),
    ]);

    await assert.rejects(
      publishChromeWebStore({
        zipPath,
        env,
        fetchImpl,
        log: (line) => logs.push(String(line)),
      }),
      /upload failed: itemId does not match configured extension ID/u,
    );

    assertNoPublishRequest(calls);
    assert.deepEqual(logs, []);
    assertLogsOmitCredentials(logs, env);
  });
});

test('rejects a non-success upload state before publishing', async () => {
  await withTemporaryZip(async (zipPath) => {
    const env = environment();
    const logs = [];
    const { calls, fetchImpl } = createFetchSequence([
      jsonResponse({ access_token: ACCESS_TOKEN }),
      jsonResponse(successfulUpload(env, {
        uploadState: 'IN_PROGRESS',
      })),
    ]);

    await assert.rejects(
      publishChromeWebStore({
        zipPath,
        env,
        fetchImpl,
        log: (line) => logs.push(String(line)),
      }),
      /upload failed with state IN_PROGRESS/u,
    );

    assertNoPublishRequest(calls);
    assert.deepEqual(logs, []);
    assertLogsOmitCredentials(logs, env);
  });
});

test('rejects a successful upload for a different item before publishing', async () => {
  await withTemporaryZip(async (zipPath) => {
    const env = environment();
    const logs = [];
    const { calls, fetchImpl } = createFetchSequence([
      jsonResponse({ access_token: ACCESS_TOKEN }),
      jsonResponse(successfulUpload(env, {
        itemId: 'different-extension-id',
      })),
    ]);

    await assert.rejects(
      publishChromeWebStore({
        zipPath,
        env,
        fetchImpl,
        log: (line) => logs.push(String(line)),
      }),
      /upload failed: itemId does not match configured extension ID/u,
    );

    assertNoPublishRequest(calls);
    assert.deepEqual(logs, []);
    assertLogsOmitCredentials(logs, env);
  });
});


test('rejects a publish response without a state', async () => {
  await withTemporaryZip(async (zipPath) => {
    const env = environment();
    const logs = [];
    const { calls, fetchImpl } = createFetchSequence([
      jsonResponse({ access_token: ACCESS_TOKEN }),
      jsonResponse(successfulUpload(env)),
      jsonResponse({
        name: resourcePath(env),
        itemId: env.CWS_EXTENSION_ID,
      }),
    ]);

    await assert.rejects(
      publishChromeWebStore({
        zipPath,
        env,
        fetchImpl,
        log: (line) => logs.push(String(line)),
      }),
      /publish failed with state missing/u,
    );

    assert.deepEqual(calls.map(({ url }) => url), [OAUTH_URL, UPLOAD_URL, PUBLISH_URL]);
    assert.deepEqual(logs, []);
    assertLogsOmitCredentials(logs, env);
  });
});

test('rejects a publish response with a terminal failure state', async () => {
  await withTemporaryZip(async (zipPath) => {
    const env = environment();
    const logs = [];
    const { calls, fetchImpl } = createFetchSequence([
      jsonResponse({ access_token: ACCESS_TOKEN }),
      jsonResponse(successfulUpload(env)),
      jsonResponse(successfulPublish(env, { state: 'REJECTED' })),
    ]);

    await assert.rejects(
      publishChromeWebStore({
        zipPath,
        env,
        fetchImpl,
        log: (line) => logs.push(String(line)),
      }),
      /publish failed with state REJECTED/u,
    );

    assert.deepEqual(calls.map(({ url }) => url), [OAUTH_URL, UPLOAD_URL, PUBLISH_URL]);
    assert.deepEqual(logs, []);
    assertLogsOmitCredentials(logs, env);
  });
});

test('rejects a staged response for default publishing', async () => {
  await withTemporaryZip(async (zipPath) => {
    const env = environment();
    const logs = [];
    const { calls, fetchImpl } = createFetchSequence([
      jsonResponse({ access_token: ACCESS_TOKEN }),
      jsonResponse(successfulUpload(env)),
      jsonResponse(successfulPublish(env, { state: 'STAGED' })),
    ]);

    await assert.rejects(
      publishChromeWebStore({
        zipPath,
        env,
        fetchImpl,
        log: (line) => logs.push(String(line)),
      }),
      /publish failed with state STAGED/u,
    );

    assert.deepEqual(calls.map(({ url }) => url), [OAUTH_URL, UPLOAD_URL, PUBLISH_URL]);
    assert.deepEqual(logs, []);
    assertLogsOmitCredentials(logs, env);
  });
});

test('rejects a successful publish response without an item ID', async () => {
  await withTemporaryZip(async (zipPath) => {
    const env = environment();
    const logs = [];
    const { calls, fetchImpl } = createFetchSequence([
      jsonResponse({ access_token: ACCESS_TOKEN }),
      jsonResponse(successfulUpload(env)),
      jsonResponse({
        name: resourcePath(env),
        state: 'PENDING_REVIEW',
      }),
    ]);

    await assert.rejects(
      publishChromeWebStore({
        zipPath,
        env,
        fetchImpl,
        log: (line) => logs.push(String(line)),
      }),
      /publish failed: itemId does not match configured extension ID/u,
    );

    assert.deepEqual(calls.map(({ url }) => url), [OAUTH_URL, UPLOAD_URL, PUBLISH_URL]);
    assert.deepEqual(logs, []);
    assertLogsOmitCredentials(logs, env);
  });
});

test('propagates a publish HTTP failure after one proven upload', async () => {
  await withTemporaryZip(async (zipPath) => {
    const env = environment();
    const logs = [];
    const { calls, fetchImpl } = createFetchSequence([
      jsonResponse({ access_token: ACCESS_TOKEN }),
      jsonResponse(successfulUpload(env)),
      failedResponse(503, 'publisher unavailable'),
    ]);

    await assert.rejects(
      publishChromeWebStore({
        zipPath,
        env,
        fetchImpl,
        log: (line) => logs.push(String(line)),
      }),
      /Chrome Web Store API failed: 503 publisher unavailable/u,
    );

    assert.deepEqual(calls.map(({ url }) => url), [OAUTH_URL, UPLOAD_URL, PUBLISH_URL]);
    assert.equal(calls.filter(({ url }) => url === UPLOAD_URL).length, 1);
    assert.equal(calls.filter(({ url }) => url === PUBLISH_URL).length, 1);
    assert.deepEqual(logs, []);
    assertLogsOmitCredentials(logs, env);
  });
});

test('rejects an unsupported publish type before any network request', async () => {
  await withTemporaryZip(async (zipPath) => {
    const env = {
      ...environment(),
      CWS_PUBLISH_TYPE: 'UNSUPPORTED_PUBLISH',
    };
    const logs = [];
    const calls = [];

    await assert.rejects(
      publishChromeWebStore({
        zipPath,
        env,
        fetchImpl: async (...args) => {
          calls.push(args);
          throw new Error('unexpected network request');
        },
        log: (line) => logs.push(String(line)),
      }),
      /unsupported Chrome Web Store publish type: UNSUPPORTED_PUBLISH/u,
    );

    assert.deepEqual(calls, []);
    assert.deepEqual(logs, []);
    assertLogsOmitCredentials(logs, env);
  });
});

test('rejects each missing required environment value before any network request', async () => {
  await withTemporaryZip(async (zipPath) => {
    for (const key of Object.keys(BASE_ENV)) {
      const env = environment();
      delete env[key];
      const calls = [];

      await assert.rejects(
        publishChromeWebStore({
          zipPath,
          env,
          fetchImpl: async (...args) => {
            calls.push(args);
            throw new Error('unexpected network request');
          },
          log: () => {
            throw new Error('unexpected log output');
          },
        }),
        new RegExp(`missing required env: ${key}`, 'u'),
      );

      assert.deepEqual(calls, []);
    }
  });
});
