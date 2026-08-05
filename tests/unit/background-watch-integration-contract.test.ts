import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { backgroundSource, caseBlock } from '../helpers/background-case-block';

describe('Watch background integration contract', () => {
  it('uses the shared queue and only publishes a Watch-specific invalidation', () => {
    assert.match(backgroundSource, /const watchRefreshCoordinator = createWatchRefreshCoordinator\(\{/);
    assert.match(backgroundSource, /runSerialized: \(operation\) => jobQueue\.run\(operation\)/);
    assert.match(
      backgroundSource,
      /loadLiveRepositoryNames: async \(\) => \(await db\.stars\.toArray\(\)\)\s*\.filter\(\(star\) => !star\.tombstone\)\s*\.map\(\(star\) => star\.full_name\)/,
    );

    const broadcast = backgroundSource.match(
      /function broadcastWatchChanged\(\) \{([\s\S]*?)\n\}/,
    )?.[1] ?? '';
    assert.match(broadcast, /sendMessage\(\{ type: 'watchChanged' \}\)/);
    assert.doesNotMatch(broadcast, /invalidateCache|dataChanged/);
  });

  it('includes the classic Notifications PAT in development capture redaction', () => {
    const configuredSecrets = backgroundSource.match(
      /getConfiguredSecrets: async \(\) => Promise\.all\(\[([\s\S]*?)\]\)/,
    )?.[1] ?? '';
    assert.match(configuredSecrets, /authStore\.getToken\(\)/);
    assert.match(configuredSecrets, /authStore\.getWatchNotificationsToken\(\)/);
    assert.match(configuredSecrets, /authStore\.getAgentApiKey\(\)/);
  });

  it('keeps Watch request validation and failures out of Stars progress handling', () => {
    const query = caseBlock('queryWatchInbox', 'refreshWatchInbox');
    assert.match(query, /req\.unreadOnly !== undefined && typeof req\.unreadOnly !== 'boolean'/);
    assert.match(query, /const unreadOnly = req\.unreadOnly \?\? true/);
    assert.match(query, /error: 'Invalid Watch inbox query\.'/);
    assert.match(query, /error: 'Watch inbox is unavailable\.'/);
    assert.doesNotMatch(query, /setProgress|translateError/);

    for (const [name, next] of [
      ['getWatchStatus', 'queryWatchInbox'],
      ['refreshWatchInbox', 'disconnectWatchInbox'],
      ['disconnectWatchInbox', 'clearWatchData'],
      ['clearWatchData', 'getUsername'],
    ] as const) {
      const block = caseBlock(name, next);
      assert.match(block, /catch \{/);
      assert.doesNotMatch(block, /setProgress|translateError/);
    }
  });

  it('reconciles an account boundary without polling or nested queue work', () => {
    const listener = backgroundSource.match(
      /chrome\.storage\.onChanged\.addListener\(\(changes, areaName\) => \{([\s\S]*?)\n\}\);\nconst organizeJobRunConnections/,
    )?.[1] ?? '';
    assert.match(listener, /changes\[CONFIG_STORAGE_KEY\]\s*\?\?\s*changes\[GITHUB_CREDENTIALS_STORAGE_KEY\]/);
    assert.match(listener, /watchMainAccountChanged\(configChange\)/);
    assert.match(listener, /void watchRefreshCoordinator\.reconcileAccount\(\{/);
    assert.match(listener, /invalidateNotificationsIdentity: watchNotificationsIdentity\(configChange\.oldValue\)/);
    assert.doesNotMatch(listener, /jobQueue\.run/);
    assert.doesNotMatch(listener, /watchStore\.clearWatchData/);
    assert.doesNotMatch(listener, /watchRefreshCoordinator\.refresh|fetchGitHub/);
  });

  it('keeps same-login main credential replacement separate from an account boundary', () => {
    const helper = backgroundSource.match(
      /function watchMainAccountChanged\([\s\S]*?\n\}/,
    )?.[0] ?? '';
    assert.match(helper, /const previous = watchAccountLogin\(change\.oldValue\)/);
    assert.match(helper, /const next = watchAccountLogin\(change\.newValue\)/);
    assert.doesNotMatch(helper, /tokenEncrypted|tokenCryptoMeta/);
  });

  it('resolves Watch repository detail independently of the active Stars projection', () => {
    const detail = caseBlock('getWatchRepositoryDetail', 'refreshWatchInbox');
    assert.match(detail, /canonicalRepositoryFullName\(req\.fullName\)/);
    assert.match(detail, /!row\.tombstone/);
    assert.match(detail, /row\.full_name\.toLowerCase\(\) === fullName/);
    assert.match(detail, /idbTagStore\.get\(star\.full_name\)/);
    assert.doesNotMatch(detail, /queryStars|invalidateCache|broadcastDataChanged/);
  });
});
