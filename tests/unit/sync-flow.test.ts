import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { runSyncActionWithAutoTag } from '../../src/background/sync-flow.ts';

describe('Sync flow orchestration', () => {
  it('syncIncremental runs sync first, then auto-tag', async () => {
    const order: string[] = [];
    const result = await runSyncActionWithAutoTag(
      'syncIncremental',
      async () => {
        order.push('sync');
        return { added: 3 };
      },
      async (phase) => {
        order.push(`auto:${phase}`);
        return { tagged: 2 };
      },
    );
    assert.deepEqual(order, ['sync', 'auto:incremental']);
    assert.deepEqual(result, { sync: { added: 3 }, autoTag: { tagged: 2 } });
  });

  it('syncFull runs full sync first, then auto-tag', async () => {
    const order: string[] = [];
    const result = await runSyncActionWithAutoTag(
      'syncFull',
      async () => {
        order.push('sync');
        return { added: 10, updated: 4 };
      },
      async (phase) => {
        order.push(`auto:${phase}`);
        return { tagged: 7 };
      },
    );
    assert.deepEqual(order, ['sync', 'auto:full']);
    assert.deepEqual(result, { sync: { added: 10, updated: 4 }, autoTag: { tagged: 7 } });
  });

  it('syncRescan skips auto-tag', async () => {
    const order: string[] = [];
    const result = await runSyncActionWithAutoTag(
      'syncRescan',
      async () => {
        order.push('sync');
        return { tombstoned: 1, revived: 2 };
      },
      async (phase) => {
        order.push(`auto:${phase}`);
        return { tagged: 99 };
      },
    );
    assert.deepEqual(order, ['sync']);
    assert.deepEqual(result, { sync: { tombstoned: 1, revived: 2 }, autoTag: null });
  });
});
