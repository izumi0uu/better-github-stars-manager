import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  ORGANIZE_APPLY_RECOVERY_ALARM,
  createOrganizeApplyRecovery,
  type RecoverableOrganizeApply,
} from '@/background/organize-apply-recovery';

function createHarness(initial: RecoverableOrganizeApply | null) {
  let active = initial;
  let running = false;
  const operations: string[] = [];
  const listeners: Array<(name: string) => void> = [];
  const recovery = createOrganizeApplyRecovery({
    async createAlarm(name, delayInMinutes) {
      operations.push(`create:${name}:${delayInMinutes}`);
    },
    async clearAlarm(name) {
      operations.push(`clear:${name}`);
    },
    addAlarmListener(listener) {
      listeners.push(listener);
    },
    async getRecoverableApply() {
      return active;
    },
    async recoverExpiredLeases() {
      operations.push('recover-expired');
      if (active?.status === 'applying') active = { ...active, status: 'apply_sealed' };
    },
    isRunning() {
      return running;
    },
    async pump(applyId) {
      operations.push(`pump:${applyId}`);
      active = null;
    },
  });
  return {
    recovery,
    listeners,
    operations,
    setRunning(value: boolean) { running = value; },
  };
}

describe('organize Apply recovery alarm', () => {
  it('arms before an approved Apply and clears after durable completion', async () => {
    const run = createHarness({ applyId: 'apply-1', status: 'apply_sealed' });

    await run.recovery.start('apply-1');

    assert.deepEqual(run.operations, [
      `create:${ORGANIZE_APPLY_RECOVERY_ALARM}:0.5`,
      'pump:apply-1',
      `clear:${ORGANIZE_APPLY_RECOVERY_ALARM}`,
    ]);
  });

  it('recovers an expired applying lease before pumping after worker wake', async () => {
    const run = createHarness({ applyId: 'apply-2', status: 'applying' });

    await run.recovery.recover();

    assert.deepEqual(run.operations, [
      `create:${ORGANIZE_APPLY_RECOVERY_ALARM}:0.5`,
      'recover-expired',
      `create:${ORGANIZE_APPLY_RECOVERY_ALARM}:0.5`,
      'pump:apply-2',
      `clear:${ORGANIZE_APPLY_RECOVERY_ALARM}`,
    ]);
  });

  it('leaves the next wake armed without disturbing a live local pump', async () => {
    const run = createHarness({ applyId: 'apply-3', status: 'applying' });
    run.setRunning(true);

    await run.recovery.recover();

    assert.deepEqual(run.operations, [
      `create:${ORGANIZE_APPLY_RECOVERY_ALARM}:0.5`,
    ]);
  });

  it('registers one named listener even when install is repeated', () => {
    const run = createHarness(null);

    run.recovery.install();
    run.recovery.install();

    assert.equal(run.listeners.length, 1);
    run.listeners[0]?.('unrelated-alarm');
    assert.equal(run.operations.length, 0);
  });
});
