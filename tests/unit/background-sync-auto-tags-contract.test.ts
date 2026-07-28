import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { backgroundSource, caseBlock } from '../helpers/background-case-block';

describe('background sync auto-tag contract', () => {
  it('does not keep the old sync auto-tag helper wired into background actions', () => {
    assert.doesNotMatch(backgroundSource, /sync-flow/);
    assert.doesNotMatch(backgroundSource, /runSyncActionWithAutoTag/);
    assert.doesNotMatch(backgroundSource, /autoTagPhaseForSync/);
  });

  it('runs incremental sync without auto-tagging and keeps tagged zero for compatibility', () => {
    const block = caseBlock('syncIncremental', 'syncFull');

    assert.match(block, /githubStarSource\.syncIncremental\(\)/);
    assert.match(block, /setIdleMessage\(m\.background\.incrementalDone\(result\.added\)\)/);
    assert.match(block, /tagged: 0/);
    assert.doesNotMatch(block, /autoTagAll/);
    assert.doesNotMatch(block, /autoAssignDone/);
  });

  it('runs full sync and backfill without auto-tagging or nested full-sync runners', () => {
    assert.match(backgroundSource, /const result = await githubStarSource\.syncFull\(\(p\) => setProgress\(p\)\);/);
    assert.match(backgroundSource, /async function performFullSync\(\)\s*\{\s*return run\(performFullSyncJob\);\s*\}/);
    assert.match(backgroundSource, /setIdleMessage\(m\.background\.fullDone\(result\.added\)\)/);

    const fullBlock = caseBlock('syncFull', 'syncRescan');
    assert.match(fullBlock, /performFullSync\(\)/);
    assert.match(fullBlock, /tagged: 0/);
    assert.doesNotMatch(fullBlock, /autoTagAll/);
    assert.doesNotMatch(fullBlock, /autoAssignDone/);

    const backfillBlock = caseBlock('runBackfill', 'deferBackfill');
    assert.match(backfillBlock, /backfillExecutor\.runBackfill/);
    assert.doesNotMatch(backfillBlock, /performFullSync\(\)/);
    assert.doesNotMatch(backfillBlock, /autoTagAll/);
  });

  it('keeps Auto Tags as the manual local auto-tag entrypoint', () => {
    const block = caseBlock('autoAssignTags', 'gistPush');

    assert.match(block, /autoTagAll\(/);
    assert.match(block, /setIdleMessage\(m\.background\.autoAssignDone\(t\.tagged\)\)/);
    assert.doesNotMatch(block, /runBgsmAgentTurn\(/);
  });

  it('keeps local auto-tagging out of every automatic sync/backfill path', () => {
    for (const [name, nextName] of [
      ['syncIncremental', 'syncFull'],
      ['syncFull', 'syncRescan'],
      ['runBackfill', 'deferBackfill'],
    ] as const) {
      assert.doesNotMatch(caseBlock(name, nextName), /autoTagAll/, `${name} should not call autoTagAll`);
      assert.doesNotMatch(caseBlock(name, nextName), /runBgsmAgentTurn/, `${name} should not run BGSM Agent automatically`);
    }
  });
});
