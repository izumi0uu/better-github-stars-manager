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
  let activeWork: Promise<void> | null = null;
  let activeKey: string | null = null;
  let activeOperationId: string | null = null;
  let workTail: Promise<void> = Promise.resolve();
  const queuedWork = new Map<string, Promise<void>>();

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

  const startOnce = async (operationId: string): Promise<void> => {
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
      activeOperationId = null;
      await dependencies.clearAlarm(dependencies.alarmName);
      return;
    }
    activeOperationId = active.operationId;
    await arm();
    if (await dependencies.isRunning(active.operationId)) return;

    await dependencies.recoverExpiredLeases();
    const recovered = await dependencies.getRecoverableOperation();
    if (!recovered) {
      activeOperationId = null;
      await dependencies.clearAlarm(dependencies.alarmName);
      return;
    }
    activeOperationId = recovered.operationId;
    await startOnce(recovered.operationId);
  };

  const enqueue = (key: string, work: () => Promise<void>): Promise<void> => {
    const queued = queuedWork.get(key);
    if (queued) return queued;
    const operation = workTail.then(async () => {
      activeKey = key;
      activeWork = operation;
      try {
        await work();
      } finally {
        if (activeWork === operation) {
          activeWork = null;
          activeKey = null;
          activeOperationId = null;
        }
      }
    });
    queuedWork.set(key, operation);
    workTail = operation.catch(() => undefined);
    const removeQueued = () => {
      if (queuedWork.get(key) === operation) queuedWork.delete(key);
    };
    void operation.then(removeQueued, removeQueued);
    return operation;
  };

  const start = (operationId: string): Promise<void> => {
    if (activeWork && activeOperationId === operationId) return activeWork;
    return enqueue(`start:${operationId}`, async () => {
      const current = await dependencies.getRecoverableOperation();
      if (!current || current.operationId !== operationId) {
        await reconcile();
        return;
      }
      activeOperationId = operationId;
      await startOnce(operationId);
    });
  };

  const recover = (): Promise<void> => {
    if (activeWork && activeKey?.startsWith('start:')) return activeWork;
    return enqueue('recover', recoverOnce);
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
