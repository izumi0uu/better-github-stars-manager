import { authStore } from "@/auth/auth-store";
import { BACKFILL_IDS, normalizeBackfillMap } from "@/upgrades/backfill-state";
import {
  backfillTasks,
  reconcileBackfillMap,
  type BackfillTaskDef,
} from "@/upgrades/tasks";
import type { BackfillId, BackfillMap, BackfillState } from "@/types";

type BackfillConfigStore = Pick<typeof authStore, "getConfig" | "update">;

export type BackfillStateMutator = (
  current: BackfillState | undefined,
  now: string,
) => BackfillState;

export function isBackfillId(id: unknown): id is BackfillId {
  return (
    typeof id === "string" && (BACKFILL_IDS as readonly string[]).includes(id)
  );
}

export function getBackfillTask(id: unknown): BackfillTaskDef | null {
  if (!isBackfillId(id)) return null;
  // Message payloads are runtime data; verify both the allowlist and task
  // registry before any config mutation can happen.
  return Object.prototype.hasOwnProperty.call(backfillTasks, id)
    ? backfillTasks[id]
    : null;
}

function backfillsEqual(
  a: BackfillMap | null | undefined,
  b: BackfillMap | null | undefined,
): boolean {
  return (
    JSON.stringify(normalizeBackfillMap(a)) ===
    JSON.stringify(normalizeBackfillMap(b))
  );
}

function backfillStatesEqual(
  a: BackfillState | null | undefined,
  b: BackfillState | null | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function createBackfillConfigStore(
  store: BackfillConfigStore = authStore,
  options: { isBackfillRunning?: () => boolean } = {},
) {
  let queue: Promise<void> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    // `next` carries the caller's result/error. `queue` is only the sequencing
    // signal, so recover it after failures or one rejected write would poison
    // every later backfill config mutation.
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    reconcileStoredBackfills(): Promise<BackfillMap> {
      return enqueue(async () => {
        const cfg = await store.getConfig();
        const next = await reconcileBackfillMap(cfg.backfills, {
          keepRunning: !!options.isBackfillRunning?.(),
        });
        if (!backfillsEqual(cfg.backfills, next)) {
          await store.update({ backfills: next });
        }
        return next;
      });
    },

    setBackfillState(
      id: unknown,
      mutate: BackfillStateMutator,
    ): Promise<BackfillState> {
      return enqueue(async () => {
        const task = getBackfillTask(id);
        if (!task) throw new Error(`Unknown backfill: ${String(id)}`);

        const cfg = await store.getConfig();
        const backfills = normalizeBackfillMap(cfg.backfills);
        const now = new Date().toISOString();
        // The mutator owns the state transition; this helper owns the fresh
        // config snapshot, normalization, validation, and serialized write.
        const next = mutate(backfills[task.id], now);
        if (backfillStatesEqual(backfills[task.id], next)) return next;
        backfills[task.id] = next;
        await store.update({ backfills });
        return next;
      });
    },
  };
}
