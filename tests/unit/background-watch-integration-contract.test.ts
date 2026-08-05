import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { backgroundSource, caseBlock } from '../helpers/background-case-block';

function extract(source: string, pattern: RegExp, group = 1): string {
  const match = source.match(pattern);
  assert.ok(match, `Contract anchor not found: ${pattern}`);
  const value = match[group];
  assert.ok(value, `Contract capture ${group} was empty: ${pattern}`);
  return value;
}

describe('Watch background integration contract', () => {
  it('uses the shared queue and only publishes a Watch-specific invalidation', () => {
    assert.match(backgroundSource, /const watchRefreshCoordinator = createWatchRefreshCoordinator\(\{/);
    assert.match(backgroundSource, /runSerialized: \(operation\) => jobQueue\.run\(operation\)/);
    assert.match(
      backgroundSource,
      /loadLiveRepositoryNames: async \(\) => \(await db\.stars\.toArray\(\)\)\s*\.filter\(\(star\) => !star\.tombstone\)\s*\.map\(\(star\) => star\.full_name\)/,
    );

    const broadcast = extract(
      backgroundSource,
      /function broadcastWatchChanged\(\) \{([\s\S]*?)\n\}/,
    );
    assert.match(broadcast, /sendMessage\(\{ type: 'watchChanged' \}\)/);
    assert.doesNotMatch(broadcast, /invalidateCache|dataChanged/);
  });

  it('includes the classic Notifications PAT in development capture redaction', () => {
    const configuredSecrets = extract(
      backgroundSource,
      /getConfiguredSecrets: async \(\) => Promise\.all\(\[([\s\S]*?)\]\)/,
    );
    assert.match(configuredSecrets, /authStore\.getToken\(\)/);
    assert.match(configuredSecrets, /authStore\.getWatchNotificationsToken\(\)/);
    assert.match(configuredSecrets, /authStore\.getAgentApiKey\(\)/);
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

  it('reconciles an account boundary without polling or nested queue work', () => {
    const listener = extract(
      backgroundSource,
      /chrome\.storage\.onChanged\.addListener\(\(changes, areaName\) => \{([\s\S]*?)\n\}\);\nconst organizeJobRunConnections/,
    );
    assert.match(listener, /const credentialsChange = changes\[GITHUB_CREDENTIALS_STORAGE_KEY\]/);
    assert.match(listener, /const accountChange = credentialsChange \?\? changes\[CONFIG_STORAGE_KEY\]/);
    assert.match(listener, /watchMainAccountChanged\(accountChange\)/);
    assert.match(listener, /void watchRefreshCoordinator\.reconcileAccount\(\{/);
    assert.match(listener, /invalidateNotificationsIdentity: watchNotificationsIdentity\(accountChange\.oldValue\)/);
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
});
