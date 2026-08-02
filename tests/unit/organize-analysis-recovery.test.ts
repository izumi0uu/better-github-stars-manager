import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  ORGANIZE_ANALYSIS_RECOVERY_ALARM,
  createOrganizeAnalysisRecovery,
  type RecoverableOrganizeAnalysis,
} from '@/background/organize-analysis-recovery';

function createHarness(initial: RecoverableOrganizeAnalysis | null) {
  let active = initial;
  let running = false;
  const operations: string[] = [];
  const listeners: Array<(name: string) => void> = [];
  const recovery = createOrganizeAnalysisRecovery({
    async createAlarm(name, delayInMinutes) {
      operations.push(`create:${name}:${delayInMinutes}`);
    },
    async clearAlarm(name) {
      operations.push(`clear:${name}`);
    },
    addAlarmListener(listener) {
      listeners.push(listener);
    },
    async getRecoverableAnalysis() {
      return active;
    },
    async recoverExpiredLeases() {
      operations.push('recover-expired');
    },
    async isRunning() {
      return running;
    },
    async pump(jobId) {
      operations.push(`pump:${jobId}`);
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

describe('organize analysis recovery alarm', () => {
  it('arms before analysis and clears after durable completion', async () => {
    const run = createHarness({ jobId: 'job-1', status: 'analyzing' });

    await run.recovery.start('job-1');

    assert.deepEqual(run.operations, [
      `create:${ORGANIZE_ANALYSIS_RECOVERY_ALARM}:1`,
      'pump:job-1',
      `clear:${ORGANIZE_ANALYSIS_RECOVERY_ALARM}`,
    ]);
  });

  it('recovers leases and resumes without an attached UI after worker wake', async () => {
    const run = createHarness({ jobId: 'job-2', status: 'analyzing' });

    await run.recovery.recover();

    assert.deepEqual(run.operations, [
      `create:${ORGANIZE_ANALYSIS_RECOVERY_ALARM}:1`,
      'recover-expired',
      `create:${ORGANIZE_ANALYSIS_RECOVERY_ALARM}:1`,
      'pump:job-2',
      `clear:${ORGANIZE_ANALYSIS_RECOVERY_ALARM}`,
    ]);
  });

  it('deduplicates alarm recovery and a concurrent explicit start for the same job', async () => {
    let active: RecoverableOrganizeAnalysis | null = { jobId: 'job-2', status: 'analyzing' };
    const operations: string[] = [];
    let releasePump!: () => void;
    const pumpGate = new Promise<void>((resolve) => { releasePump = resolve; });
    let notifyPumpStarted!: () => void;
    const pumpStarted = new Promise<void>((resolve) => { notifyPumpStarted = resolve; });
    const recovery = createOrganizeAnalysisRecovery({
      async createAlarm(name, delayInMinutes) {
        operations.push(`create:${name}:${delayInMinutes}`);
      },
      async clearAlarm(name) {
        operations.push(`clear:${name}`);
      },
      addAlarmListener() {},
      async getRecoverableAnalysis() {
        return active;
      },
      async recoverExpiredLeases() {
        operations.push('recover-expired');
      },
      isRunning() {
        return false;
      },
      async pump(jobId) {
        operations.push(`pump:${jobId}`);
        notifyPumpStarted();
        await pumpGate;
        active = null;
      },
    });

    const alarmRecovery = recovery.recover();
    await pumpStarted;
    const explicitStart = recovery.start('job-2');
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(operations.filter((entry) => entry === 'recover-expired').length, 1);
    assert.equal(operations.filter((entry) => entry === 'pump:job-2').length, 1);

    releasePump();
    await Promise.all([alarmRecovery, explicitStart]);
    assert.deepEqual(operations, [
      `create:${ORGANIZE_ANALYSIS_RECOVERY_ALARM}:1`,
      'recover-expired',
      `create:${ORGANIZE_ANALYSIS_RECOVERY_ALARM}:1`,
      'pump:job-2',
      `clear:${ORGANIZE_ANALYSIS_RECOVERY_ALARM}`,
    ]);
  });

  it('keeps the alarm armed without taking over a live scheduler', async () => {
    const run = createHarness({ jobId: 'job-3', status: 'analyzing' });
    run.setRunning(true);

    await run.recovery.recover();

    assert.deepEqual(run.operations, [
      `create:${ORGANIZE_ANALYSIS_RECOVERY_ALARM}:1`,
    ]);
  });

  it('installs one named alarm listener', () => {
    const run = createHarness(null);

    run.recovery.install();
    run.recovery.install();

    assert.equal(run.listeners.length, 1);
    run.listeners[0]?.('unrelated-alarm');
    assert.equal(run.operations.length, 0);
  });
});
