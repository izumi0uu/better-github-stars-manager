export const ORGANIZE_APPLY_RECOVERY_ALARM = 'bgsm-organize-apply-recovery-v1';
export const ORGANIZE_APPLY_RECOVERY_DELAY_MINUTES = 0.5;

export type RecoverableOrganizeApply = Readonly<{
  applyId: string;
  status: 'apply_sealed' | 'applying';
}>;

export type OrganizeApplyRecoveryDependencies = Readonly<{
  createAlarm(name: string, delayInMinutes: number): Promise<void>;
  clearAlarm(name: string): Promise<void>;
  addAlarmListener(listener: (name: string) => void): void;
  getRecoverableApply(): Promise<RecoverableOrganizeApply | null>;
  recoverExpiredLeases(): Promise<void>;
  isRunning(applyId: string): boolean;
  pump(applyId: string): Promise<void>;
  onError?(error: unknown): void;
}>;

/** Keeps an approved durable Apply recoverable across MV3 worker suspension. */
export function createOrganizeApplyRecovery(
  dependencies: OrganizeApplyRecoveryDependencies,
) {
  const recovery = createDurableJobRecovery({
    alarmName: ORGANIZE_APPLY_RECOVERY_ALARM,
    recoveryDelayMinutes: ORGANIZE_APPLY_RECOVERY_DELAY_MINUTES,
    createAlarm: dependencies.createAlarm,
    clearAlarm: dependencies.clearAlarm,
    addAlarmListener: dependencies.addAlarmListener,
    async getRecoverableOperation() {
      const apply = await dependencies.getRecoverableApply();
      return apply && { ...apply, operationId: apply.applyId };
    },
    recoverExpiredLeases: dependencies.recoverExpiredLeases,
    isRunning: dependencies.isRunning,
    pump: dependencies.pump,
    onError: dependencies.onError,
  });
  return recovery;
}
import { createDurableJobRecovery } from './durable-job-recovery';
