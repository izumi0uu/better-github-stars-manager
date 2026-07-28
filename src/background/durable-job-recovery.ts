export type RecoverableDurableOperation = Readonly<{
  operationId: string;
}>;

export type DurableJobRecoveryDependencies<
  TOperation extends RecoverableDurableOperation,
> = Readonly<{
  alarmName: string;
  recoveryDelayMinutes: number;
  createAlarm(name: string, delayInMinutes: number): Promise<void>;
  clearAlarm(name: string): Promise<void>;
  addAlarmListener(listener: (name: string) => void): void;
  getRecoverableOperation(): Promise<TOperation | null>;
  recoverExpiredLeases(): Promise<void>;
  isRunning(operationId: string): boolean | Promise<boolean>;
  pump(operationId: string): Promise<void>;
  onError?(error: unknown): void;
}>;

/** Re-arms durable work before touching state so MV3 suspension stays recoverable. */
export function createDurableJobRecovery<
  TOperation extends RecoverableDurableOperation,
>(dependencies: DurableJobRecoveryDependencies<TOperation>) {
  let installed = false;
  let recovery: Promise<void> | null = null;

  const arm = async (): Promise<void> => {
    await dependencies.createAlarm(
      dependencies.alarmName,
      dependencies.recoveryDelayMinutes,
    );
  };

  const reconcile = async (): Promise<void> => {
    if (await dependencies.getRecoverableOperation()) {
      await arm();
      return;
    }
    await dependencies.clearAlarm(dependencies.alarmName);
  };

  const start = async (operationId: string): Promise<void> => {
    await arm();
    try {
      await dependencies.pump(operationId);
    } finally {
      await reconcile();
    }
  };

  const recoverOnce = async (): Promise<void> => {
    const active = await dependencies.getRecoverableOperation();
    if (!active) {
      await dependencies.clearAlarm(dependencies.alarmName);
      return;
    }
    await arm();
    if (await dependencies.isRunning(active.operationId)) return;

    await dependencies.recoverExpiredLeases();
    const recovered = await dependencies.getRecoverableOperation();
    if (!recovered) {
      await dependencies.clearAlarm(dependencies.alarmName);
      return;
    }
    await start(recovered.operationId);
  };

  const recover = (): Promise<void> => {
    if (recovery) return recovery;
    const operation = recoverOnce().finally(() => {
      if (recovery === operation) recovery = null;
    });
    recovery = operation;
    return operation;
  };

  const runInBackground = (): void => {
    void recover().catch((error) => dependencies.onError?.(error));
  };

  return Object.freeze({
    arm,
    reconcile,
    recover,
    start,
    install(): void {
      if (installed) return;
      installed = true;
      dependencies.addAlarmListener((name) => {
        if (name === dependencies.alarmName) runInBackground();
      });
      runInBackground();
    },
  });
}
