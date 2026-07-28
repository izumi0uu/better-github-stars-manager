import { createDurableJobRecovery } from './durable-job-recovery';

export const ORGANIZE_ANALYSIS_RECOVERY_ALARM = 'bgsm-organize-analysis-recovery-v1';
export const ORGANIZE_ANALYSIS_RECOVERY_DELAY_MINUTES = 1;

export type RecoverableOrganizeAnalysis = Readonly<{
  jobId: string;
  status: 'analyzing';
}>;

export type OrganizeAnalysisRecoveryDependencies = Readonly<{
  createAlarm(name: string, delayInMinutes: number): Promise<void>;
  clearAlarm(name: string): Promise<void>;
  addAlarmListener(listener: (name: string) => void): void;
  getRecoverableAnalysis(): Promise<RecoverableOrganizeAnalysis | null>;
  recoverExpiredLeases(): Promise<void>;
  isRunning(jobId: string): boolean | Promise<boolean>;
  pump(jobId: string): Promise<void>;
  onError?(error: unknown): void;
}>;

/** Keeps durable analysis moving when no extension page remains connected. */
export function createOrganizeAnalysisRecovery(
  dependencies: OrganizeAnalysisRecoveryDependencies,
) {
  return createDurableJobRecovery({
    alarmName: ORGANIZE_ANALYSIS_RECOVERY_ALARM,
    recoveryDelayMinutes: ORGANIZE_ANALYSIS_RECOVERY_DELAY_MINUTES,
    createAlarm: dependencies.createAlarm,
    clearAlarm: dependencies.clearAlarm,
    addAlarmListener: dependencies.addAlarmListener,
    async getRecoverableOperation() {
      const analysis = await dependencies.getRecoverableAnalysis();
      return analysis && { ...analysis, operationId: analysis.jobId };
    },
    recoverExpiredLeases: dependencies.recoverExpiredLeases,
    isRunning: dependencies.isRunning,
    pump: dependencies.pump,
    onError: dependencies.onError,
  });
}
