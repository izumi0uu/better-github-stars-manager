import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeOptionsIntent,
  OPTIONS_INTENT_STORAGE_KEY,
  parseOptionsIntent,
  writeOptionsIntent,
} from '@/utils/options-intent';
import { backgroundSource, caseBlock } from '../helpers/background-case-block';

const optionsSource = readFileSync(
  new URL('../../src/options/Options.tsx', import.meta.url),
  'utf8',
);
const watchContractSource = readFileSync(
  new URL('../../src/watch/watch-contract.ts', import.meta.url),
  'utf8',
);
const watchRefreshSource = readFileSync(
  new URL('../../src/background/watch-refresh.ts', import.meta.url),
  'utf8',
);

function installOptionsSessionMock(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const session = {
    get: vi.fn(async (key: string) => ({ [key]: values.get(key) })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
  vi.stubGlobal('chrome', { storage: { session } });
  return { session, values };
}

function extract(source: string, pattern: RegExp, group = 1): string {
  const match = source.match(pattern);
  assert.ok(match, `Contract anchor not found: ${pattern}`);
  const value = match[group];
  assert.ok(value, `Contract capture ${group} was empty: ${pattern}`);
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Watch background integration contract', () => {
  it('uses the shared queue and only publishes a Watch-specific invalidation', () => {
    assert.match(backgroundSource, /const watchRefreshCoordinator = createWatchRefreshCoordinator\(\{/);
    assert.match(backgroundSource, /runSerialized: \(operation\) => jobQueue\.run\(operation\)/);
    assert.match(
      backgroundSource,
      /loadLiveRepositoryNames: async \(\) => \(await db\.stars\.toArray\(\)\)\s*\.filter\(\(star\) => !star\.tombstone && star\.viewer_has_starred !== false\)\s*\.map\(\(star\) => star\.full_name\)/,
    );

    const broadcast = extract(
      backgroundSource,
      /function broadcastWatchChanged\(\) \{([\s\S]*?)\n\}/,
    );
    assert.match(broadcast, /sendMessage\(\{ type: 'watchChanged' \}\)/);
    assert.doesNotMatch(broadcast, /invalidateCache|dataChanged/);
  });

  it('scrubs only configured GitHub secrets from diagnostics', () => {
    const configuredSecrets = extract(
      backgroundSource,
      /getConfiguredSecrets: async \(\) => Promise\.all\(\[([\s\S]*?)\]\)/,
    );
    assert.match(configuredSecrets, /authStore\.getToken\(\)/);
    assert.doesNotMatch(configuredSecrets, /getWatchNotificationsToken|getAgentApiKey/);
  });

  it('keeps Watch request validation and failures out of Stars progress handling', () => {
    const query = caseBlock('queryWatchInbox', 'refreshWatchInbox');
    assert.match(query, /req\.unreadOnly !== undefined && typeof req\.unreadOnly !== 'boolean'/);
    assert.match(query, /const unreadOnly = req\.unreadOnly \?\? true/);
    assert.match(query, /const m = await getLocaleMessages\(\)/);
    assert.match(query, /error: m\.background\.watchInboxQueryInvalid/);
    assert.match(query, /error: m\.background\.watchInboxUnavailable/);
    assert.doesNotMatch(query, /setProgress|translateError/);

    for (const [name, next, message] of [
      ['getWatchStatus', 'queryWatchInbox', 'watchStatusUnavailable'],
      ['refreshWatchInbox', 'disconnectWatchInbox', 'watchRefreshFailed'],
      ['disconnectWatchInbox', 'clearWatchData', 'watchDisconnectFailed'],
      ['clearWatchData', 'getUsername', 'watchDataClearFailed'],
    ] as const) {
      const block = caseBlock(name, next);
      assert.match(block, /catch \{/);
      assert.match(block, /const m = await getLocaleMessages\(\)/);
      assert.match(block, new RegExp(`error: m\\.background\\.${message}`));
      assert.doesNotMatch(block, /setProgress|translateError/);
    }
  });

  it('validates Watch notification mutations and keeps them inside the Watch queue', () => {
    assert.match(backgroundSource, /type: ["']markWatchThreadsRead["']; accountLogin\?: unknown; threadIds\?: unknown/);
    assert.match(backgroundSource, /type: ["']markWatchThreadsDone["']; accountLogin\?: unknown; threadIds\?: unknown/);
    const block = caseBlock('markWatchThreadsDone', 'disconnectWatchInbox');
    assert.match(block, /const accountLogin = parseWatchAccountLogin\(req\.accountLogin\)/);
    assert.match(block, /const threadIds = parseWatchThreadIds\(req\.threadIds\)/);
    assert.match(block, /const mutation = \{ accountLogin, threadIds \}/);
    assert.match(block, /watchRefreshCoordinator\.markThreadsRead\(mutation\)/);
    assert.match(block, /watchRefreshCoordinator\.markThreadsDone\(mutation\)/);
    assert.match(block, /watchThreadActionInvalid/);
    assert.match(block, /watchThreadActionFailed/);
    assert.doesNotMatch(block, /setProgress|invalidateCache|broadcastDataChanged/);
  });

  it('reconciles an account boundary without polling or nested queue work', () => {
    const listener = extract(
      backgroundSource,
      /chrome\.storage\.onChanged\.addListener\(\(changes, areaName\) => \{([\s\S]*?)\n\}\);\nconst organizeJobRunConnections/,
    );
    assert.match(listener, /const credentialsChange = changes\[GITHUB_CREDENTIALS_STORAGE_KEY\]/);
    assert.match(listener, /const accountChange = credentialsChange \?\? changes\[CONFIG_STORAGE_KEY\]/);
    assert.match(listener, /watchMainAccountChanged\(accountChange\)/);
    assert.match(listener, /void watchRefreshCoordinator\.reconcileAccount\(\)/);
    assert.doesNotMatch(listener, /jobQueue\.run/);
    assert.doesNotMatch(listener, /watchStore\.clearWatchData/);
    assert.doesNotMatch(listener, /watchRefreshCoordinator\.refresh|fetchGitHub/);
  });

  it('keeps same-login main credential replacement separate from an account boundary', () => {
    const helper = extract(
      backgroundSource,
      /function watchMainAccountChanged\([\s\S]*?\n\}/,
      0,
    );
    assert.match(helper, /const previous = watchAccountLogin\(change\.oldValue\)/);
    assert.match(helper, /const next = watchAccountLogin\(change\.newValue\)/);
    assert.doesNotMatch(helper, /tokenEncrypted|tokenCryptoMeta/);
  });

  it('resolves Watch repository detail independently of the active Stars projection', () => {
    const detail = caseBlock('getWatchRepositoryDetail', 'refreshWatchInbox');
    assert.match(detail, /const m = await getLocaleMessages\(\)/);
    assert.match(detail, /error: m\.background\.watchRepositoryInvalid/);
    assert.match(detail, /error: m\.background\.watchRepositoryDetailUnavailable/);
    assert.match(detail, /canonicalRepositoryFullName\(req\.fullName\)/);
    assert.match(detail, /!row\.tombstone/);
    assert.match(detail, /row\.full_name\.toLowerCase\(\) === fullName/);
    assert.match(detail, /idbTagStore\.get\(star\.full_name\)/);
    assert.doesNotMatch(detail, /queryStars|invalidateCache|broadcastDataChanged/);
  });

  it('validates Watch subject-detail requests and preserves stable error codes', () => {
    const detail = caseBlock('getWatchSubjectDetail', 'getWatchRepositoryDetail');
    assert.match(detail, /const threadId = parseWatchThreadId\(req\.threadId\)/);
    assert.match(detail, /error: m\.background\.watchSubjectDetailInvalid/);
    assert.match(detail, /watchRefreshCoordinator\.getSubjectDetail\(threadId\)/);
    assert.match(detail, /error instanceof GitHubWatchError \? error\.code : 'invalid_response'/);
    assert.match(detail, /error: m\.background\.watchSubjectDetailError\(code\)/);
    assert.match(detail, /code,/);
    assert.match(detail, /details: error instanceof GitHubWatchError && error\.status !== undefined/);
    assert.match(detail, /\{ status: error\.status \}/);
    assert.doesNotMatch(detail, /setProgress|invalidateCache|broadcastDataChanged/);
  });

  it('keeps Watch status based on main and Notifications availability', () => {
    assert.match(watchContractSource, /hasMainToken: boolean/);
    assert.match(watchContractSource, /hasNotificationsToken: boolean/);
    assert.doesNotMatch(watchContractSource, /credentialSource\?:/);
    assert.match(watchRefreshSource, /const hasNotificationsToken = !!auth\.notificationsToken/);
  });

  it('accepts ordinary and targeted openOptions without broadening the request', () => {
    assert.match(
      backgroundSource,
      /\|\s*\{\s*type:\s*["']openOptions["'];\s*section\?:\s*["']github["']\s*\|\s*["']watch["']\s*\}/,
    );
    assert.doesNotMatch(backgroundSource, /type:\s*["']openOptions["'];\s*section\?:\s*(?:string|unknown)/);

    const block = caseBlock('openOptions', 'devClearLocalData');
    assert.match(block, /req\.section !== ['"]github['"]/);
    assert.match(block, /req\.section !== ['"]watch['"]/);
    assert.match(block, /return \{ ok: false, error: ['"]Unsupported Options section\.['"] \}/);
    assert.match(
      block,
      /if \(req\.section !== undefined\) \{\s*await writeOptionsIntent\(req\.section\);\s*\}\s*await chrome\.runtime\.openOptionsPage\(\)/,
    );
    assert.doesNotMatch(block, /storage\.local/);
  });

  it.each(['github', 'watch'] as const)('stores and consumes the transient %s intent', async (section) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_786_225_645_000);
    const { session, values } = installOptionsSessionMock({
      unrelatedSessionState: { keep: true },
    });
    expect(OPTIONS_INTENT_STORAGE_KEY).toBe('gsm_options_intent');

    await writeOptionsIntent(section);
    expect(session.set).toHaveBeenCalledWith({
      [OPTIONS_INTENT_STORAGE_KEY]: {
        section,
        requestedAt: 1_786_225_645_000,
      },
    });
    expect(values.get('unrelatedSessionState')).toEqual({ keep: true });

    await expect(consumeOptionsIntent()).resolves.toEqual({
      section,
      requestedAt: 1_786_225_645_000,
    });
    expect(session.remove).toHaveBeenCalledWith(OPTIONS_INTENT_STORAGE_KEY);
    expect(values.has(OPTIONS_INTENT_STORAGE_KEY)).toBe(false);
    expect(values.get('unrelatedSessionState')).toEqual({ keep: true });
  });

  it('fails malformed sections closed before persistence or Options navigation', async () => {
    const { session } = installOptionsSessionMock();

    expect(parseOptionsIntent({ section: 'stars', requestedAt: 1 })).toBeNull();
    expect(parseOptionsIntent({ section: 'github', requestedAt: Number.NaN })).toBeNull();
    await expect(writeOptionsIntent('stars' as 'watch')).rejects.toThrow('Invalid Options intent section.');
    expect(session.set).not.toHaveBeenCalled();

    const block = caseBlock('openOptions', 'devClearLocalData');
    const rejectAt = block.indexOf("req.section !== 'github'");
    const writeAt = block.indexOf('writeOptionsIntent(req.section)');
    const openAt = block.indexOf('chrome.runtime.openOptionsPage()');
    assert.ok(rejectAt >= 0 && rejectAt < writeAt && writeAt < openAt);
  });

  it('consumes the intent on mount and listens for a new session intent on an already-open page', () => {
    assert.match(optionsSource, /consumeOptionsIntent\(\)/);
    assert.match(optionsSource, /OPTIONS_INTENT_STORAGE_KEY/);
    assert.match(optionsSource, /areaName !== ["']session["']/);
    assert.match(optionsSource, /changes\[OPTIONS_INTENT_STORAGE_KEY\]/);
    assert.match(optionsSource, /chrome\.storage\.onChanged\.addListener\(listener\)/);
    assert.match(optionsSource, /chrome\.storage\.onChanged\.removeListener\(listener\)/);
    assert.doesNotMatch(optionsSource, /storage\.local\.(?:set|remove)\([^)]*OPTIONS_INTENT_STORAGE_KEY/);
  });
});
