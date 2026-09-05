import type { GitHubCredentialSnapshot, authStore } from '@/auth/auth-store';
import type { FollowingHistoryWindowDays } from '@/types';
import {
  fetchGitHubRadar,
  fetchGitHubRadarReconciliationStep,
  RADAR_RATE_LIMIT_RESERVE,
  RADAR_STEP_MAX_REQUESTS,
} from '@/api/github-radar-source';
import {
  createRadarReconciliationCheckpoint,
  GitHubRadarError,
  type RadarActivityPresentation,
  type RadarErrorCode,
  RADAR_MAX_FOLLOWING,
  type RadarReconciliationCheckpoint,
  type RadarStateRecord,
} from '@/radar/radar-model';
import type {
  RadarQueryResponse,
  RadarRefreshRequest,
  RadarRefreshResult,
  RadarStatus,
} from '@/radar/radar-contract';
import {
  selectRadarRefreshPlan,
} from '@/background/radar-refresh-policy';
import {
  abandonRadarReconciliation,
  commitRadarReconciliationStep,
  commitRadarSnapshot,
  dismissRadarActivities,
  getRadarReconciliation,
  getRadarState,
  listRadarActivities,
  markRadarActivitiesSeen,
  makeRadarStatus,
  prepareRadarAccount,
  recordRadarFailure,
  startRadarReconciliation,
  clearRadarData,
} from '@/storage/radar-store';
type RadarAuth = Pick<typeof authStore, 'getGitHubCredentialSnapshot' | 'getConfig'>;
type AuthSnapshot = GitHubCredentialSnapshot;
type RadarRefreshOptions = Readonly<{ bypassPendingFull?: boolean }>;
type RadarRefreshOutcome = Readonly<{ published: boolean }>;

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1_000;
const TRANSIENT_FAILURE_COOLDOWN_MS = 5 * 60 * 1_000;

/**
 * Worst-case steps for a full graph: the followed-account cap needs two
 * Following pages plus one activity request per five actors, and one step
 * spends at most `RADAR_STEP_MAX_REQUESTS`.
 */
const RADAR_MAX_CHAINED_STEPS = Math.ceil(
  (2 + RADAR_MAX_FOLLOWING / 5) / RADAR_STEP_MAX_REQUESTS,
);

/**
 * Price another full step using the epoch's highest reported request cost.
 * The caller separately requires current-request cost evidence before chaining.
 */
function affordsAnotherStep(checkpoint: RadarReconciliationCheckpoint): boolean {
  const remaining = checkpoint.rateLimitRemaining;
  const cost = checkpoint.maxRequestCost;
  if (remaining === null || cost === null || cost <= 0) return false;
  return remaining - RADAR_STEP_MAX_REQUESTS * cost > RADAR_RATE_LIMIT_RESERVE;
}

export interface RadarRefreshCoordinatorDependencies {
  runSerialized<T>(operation: () => Promise<T>): Promise<T>;
  auth: RadarAuth;
  fetchRadar: typeof fetchGitHubRadar;
  fetchReconciliationStep: typeof fetchGitHubRadarReconciliationStep;
  store: {
    clearData: typeof clearRadarData;
    commitSnapshot: typeof commitRadarSnapshot;
    prepareAccount: typeof prepareRadarAccount;
    getState: typeof getRadarState;
    getReconciliation: typeof getRadarReconciliation;
    startReconciliation: typeof startRadarReconciliation;
    commitReconciliationStep: typeof commitRadarReconciliationStep;
    abandonReconciliation: typeof abandonRadarReconciliation;
    recordFailure: typeof recordRadarFailure;
    listActivities: typeof listRadarActivities;
    dismissActivities: typeof dismissRadarActivities;
    markActivitiesSeen: typeof markRadarActivitiesSeen;
  };
  now?: () => number;
  broadcastChanged(): void;
}

export interface RadarRefreshCoordinator {
  getStatus(): Promise<RadarStatus>;
  query(): Promise<RadarQueryResponse>;
  refresh(request?: RadarRefreshRequest): Promise<RadarRefreshResult>;
  fullReconcile(): Promise<RadarRefreshResult>;
  dismiss(activityIds: readonly string[]): Promise<RadarStatus>;
  markSeen(activityIds: readonly string[]): Promise<RadarStatus>;
  reconcileAccount(): Promise<void>;
  isRefreshing(): boolean;
}

function normalizedAccountLogin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLocaleLowerCase('en-US');
  return normalized || null;
}

function identity(auth: AuthSnapshot): string {
  return JSON.stringify([
    normalizedAccountLogin(auth.accountLogin),
    auth.mainIdentity,
    auth.mainToken !== null,
  ]);
}

function stableErrorCode(error: unknown): RadarErrorCode {
  return error instanceof GitHubRadarError ? error.code : 'network_error';
}

function allowedAtMillis(value: string | null | undefined): number {
  const millis = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(millis) ? millis : Number.NEGATIVE_INFINITY;
}

/**
 * Failures need a cooldown floor, otherwise the Following surface re-triggers
 * the same failing scan on every entry. Credential and permission failures are
 * excluded: they need a user action, and a cooldown would mask their status.
 */
function failureNextAllowedAt(error: unknown, attemptedAt: number): string | null {
  const code = stableErrorCode(error);
  if (code === 'authentication_required' || code === 'permission_denied') return null;
  if (code !== 'rate_limited') {
    return new Date(attemptedAt + TRANSIENT_FAILURE_COOLDOWN_MS).toISOString();
  }
  if (
    error instanceof GitHubRadarError
    && error.resetAt
    && Number.isFinite(Date.parse(error.resetAt))
  ) return error.resetAt;
  return new Date(attemptedAt + DEFAULT_RATE_LIMIT_COOLDOWN_MS).toISOString();
}

export function createRadarRefreshCoordinator(
  dependencies: RadarRefreshCoordinatorDependencies,
): RadarRefreshCoordinator {
  const now = dependencies.now ?? Date.now;
  let inFlight: {
    identity: string;
    request: RadarRefreshRequest;
    promise: Promise<RadarRefreshResult>;
  } | null = null;
  let pendingFull: { identity: string; promise: Promise<RadarRefreshResult> } | null = null;
  let preparedIdentity: string | null = null;

  async function readAuth(): Promise<AuthSnapshot> {
    return dependencies.auth.getGitHubCredentialSnapshot();
  }

  async function readWindowDays(): Promise<FollowingHistoryWindowDays> {
    return (await dependencies.auth.getConfig()).radarWindowDays;
  }

  async function sameCredentials(snapshot: AuthSnapshot): Promise<boolean> {
    const latest = await readAuth();
    return latest.mainToken !== null
      && identity(latest) === identity(snapshot);
  }

  async function sameRequest(
    snapshot: AuthSnapshot,
    windowDays: FollowingHistoryWindowDays,
  ): Promise<boolean> {
    const [latestAuth, latestWindowDays] = await Promise.all([readAuth(), readWindowDays()]);
    return latestAuth.mainToken !== null
      && identity(latestAuth) === identity(snapshot)
      && latestWindowDays === windowDays;
  }

  async function requestIsCurrent(
    snapshot: AuthSnapshot,
    windowDays: FollowingHistoryWindowDays,
  ): Promise<boolean> {
    try {
      return await sameRequest(snapshot, windowDays);
    } catch {
      return false;
    }
  }


  async function statusForAuth(
    auth: AuthSnapshot,
    refreshing: boolean,
    stateOverride?: RadarStateRecord | null,
    windowDaysOverride?: FollowingHistoryWindowDays,
    reconciliationOverride?: RadarReconciliationCheckpoint | null,
  ): Promise<RadarStatus> {
    const windowDays = windowDaysOverride ?? await readWindowDays();
    const hasMainToken = !!(auth.accountLogin && auth.mainToken);
    const state = stateOverride !== undefined
      ? stateOverride
      : hasMainToken && auth.accountLogin
        ? await dependencies.store.getState(auth.accountLogin)
        : null;
    const reconciliation = reconciliationOverride !== undefined
      ? reconciliationOverride
      : hasMainToken && auth.accountLogin
        ? await dependencies.store.getReconciliation(auth.accountLogin)
        : null;
    return makeRadarStatus(
      auth.accountLogin,
      hasMainToken,
      refreshing,
      state,
      now(),
      windowDays,
      reconciliation,
    );
  }

  async function reconcileAccount(): Promise<void> {
    const auth = await readAuth();
    const nextIdentity = identity(auth);
    if (preparedIdentity === nextIdentity) return;

    await dependencies.runSerialized(async () => {
      const latest = await readAuth();
      const latestIdentity = identity(latest);
      if (latest.accountLogin && latest.mainToken) {
        await dependencies.store.prepareAccount(latest.accountLogin);
      } else {
        await dependencies.store.clearData();
      }
      preparedIdentity = latestIdentity;
    });
  }

  async function getStatus(): Promise<RadarStatus> {
    await reconcileAccount();
    return statusForAuth(await readAuth(), inFlight !== null);
  }

  async function query(): Promise<RadarQueryResponse> {
    await reconcileAccount();
    const [auth, windowDays] = await Promise.all([readAuth(), readWindowDays()]);
    const accountLogin = auth.accountLogin && auth.mainToken ? auth.accountLogin : null;
    const queriedAt = now();
    const [activities, state, reconciliation] = await Promise.all([
      accountLogin
        ? dependencies.store.listActivities(accountLogin, queriedAt, windowDays)
        : Promise.resolve([] as RadarActivityPresentation[]),
      accountLogin ? dependencies.store.getState(accountLogin) : Promise.resolve(null),
      accountLogin
        ? dependencies.store.getReconciliation(accountLogin)
        : Promise.resolve(null),
    ]);
    const [latest, latestWindowDays] = await Promise.all([readAuth(), readWindowDays()]);
    if (identity(auth) !== identity(latest) || windowDays !== latestWindowDays) {
      return {
        activities: [],
        unseenCount: 0,
        status: await statusForAuth(latest, inFlight !== null, undefined, latestWindowDays),
      };
    }
    return {
      activities,
      unseenCount: activities.reduce((count, activity) => count + (activity.seen ? 0 : 1), 0),
      status: await statusForAuth(auth, inFlight !== null, state, windowDays, reconciliation),
    };
  }

function reconciliationMatches(
  checkpoint: RadarReconciliationCheckpoint,
  auth: AuthSnapshot,
  windowDays: FollowingHistoryWindowDays,
): boolean {
  return checkpoint.accountLogin === normalizedAccountLogin(auth.accountLogin)
    && checkpoint.credentialIdentity === identity(auth)
    && checkpoint.windowDays === windowDays;
}

function createReconciliationId(attemptedAt: number): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return randomUuid ? `radar-reconcile:${randomUuid}` : `radar-reconcile:${attemptedAt}:${Math.random()}`;
}

  async function performRefresh(
    auth: AuthSnapshot,
    windowDays: FollowingHistoryWindowDays,
    request: RadarRefreshRequest,
  ): Promise<RadarRefreshOutcome> {
    const accountLogin = auth.accountLogin;
    const mainToken = auth.mainToken;
    if (!accountLogin || !mainToken || !(await requestIsCurrent(auth, windowDays))) {
      return { published: false };
    }

    const attemptedAt = now();
    try {
      await dependencies.store.prepareAccount(accountLogin);
      let previousState = await dependencies.store.getState(accountLogin);
      let checkpoint = await dependencies.store.getReconciliation(accountLogin);
      if (checkpoint && !reconciliationMatches(checkpoint, auth, windowDays)) {
        await dependencies.store.abandonReconciliation(accountLogin, checkpoint.reconciliationId);
        checkpoint = null;
      }
      if (!(await requestIsCurrent(auth, windowDays))) return { published: false };

      // A GitHub quota wait is a hard boundary and comes from the rate-reserve
      // checkpoint or a rate-limited saved state. A transient-failure cooldown
      // only exists to stop automatic retry storms, so an explicit user request
      // may pass through it.
      const rateWaitMillis = Math.max(
        allowedAtMillis(checkpoint?.pauseReason === 'rate_reserve' ? checkpoint.nextAllowedAt : null),
        allowedAtMillis(previousState?.errorCode === 'rate_limited' ? previousState.nextAllowedAt : null),
      );
      if (rateWaitMillis > attemptedAt) return { published: false };
      if (
        request !== 'full'
        && allowedAtMillis(previousState?.nextAllowedAt ?? null) > attemptedAt
      ) return { published: false };

      const resumeStep = async (
        epoch: RadarReconciliationCheckpoint,
      ): Promise<{ outcome: RadarRefreshOutcome; next: RadarReconciliationCheckpoint | null }> => {
        const step = await dependencies.fetchReconciliationStep({
          token: mainToken,
          checkpoint: epoch,
          now: () => new Date(now()),
        });
        if (!(await requestIsCurrent(auth, windowDays))) {
          return { outcome: { published: false }, next: null };
        }
        const committed = await dependencies.store.commitReconciliationStep({
          accountLogin,
          credentialIdentity: identity(auth),
          windowDays,
          step,
        });
        if (!committed.applied) {
          // A rejection against the exact fence we sent is deterministic: the
          // stored cursor cannot accept this step and recomputing it would fail
          // identically, so abandon the epoch instead of stalling on it. A moved
          // fence is an ordinary race and leaves that epoch alone.
          const fenceUnmoved = committed.checkpoint !== null
            && committed.checkpoint.reconciliationId === step.expectedReconciliationId
            && committed.checkpoint.revision === step.expectedRevision;
          if (fenceUnmoved) {
            await dependencies.store.abandonReconciliation(
              accountLogin,
              step.expectedReconciliationId,
            );
          }
          return { outcome: { published: false }, next: null };
        }
        if (!(await requestIsCurrent(auth, windowDays))) {
          return { outcome: { published: false }, next: null };
        }
        dependencies.broadcastChanged();
        return {
          outcome: { published: true },
          next: step.hasCurrentRequestCost ? committed.checkpoint : null,
        };
      };

      /**
       * Run consecutive steps while one wake can still afford them. A single
       * step is bounded by its request budget, so without chaining a large
       * Following graph needs one hourly alarm per step and takes hours to
       * converge. Only a request-budget pause is chained: a deadline pause means
       * this wake is already slow, and a quota pause is a hard wait.
       */
      const runEpoch = async (
        first: RadarReconciliationCheckpoint,
      ): Promise<RadarRefreshOutcome> => {
        let epoch: RadarReconciliationCheckpoint | null = first;
        let outcome: RadarRefreshOutcome = { published: false };
        for (let step = 0; step < RADAR_MAX_CHAINED_STEPS && epoch !== null; step += 1) {
          const result = await resumeStep(epoch);
          outcome = result.outcome;
          const next = result.next;
          epoch = next !== null && next.pauseReason === 'request_budget'
            && affordsAnotherStep(next)
            ? next
            : null;
        }
        return outcome;
      };

      if (checkpoint) return runEpoch(checkpoint);

      const effectivePlan = selectRadarRefreshPlan({
        nowMillis: attemptedAt,
        selectedWindowDays: windowDays,
        credentialIdentity: identity(auth),
        state: previousState,
        forceFull: request === 'full',
      });
      if (effectivePlan.mode === 'full') {
        const started = await dependencies.store.startReconciliation(
          createRadarReconciliationCheckpoint({
            reconciliationId: createReconciliationId(attemptedAt),
            accountLogin,
            credentialIdentity: identity(auth),
            windowDays,
            startedAt: new Date(attemptedAt).toISOString(),
          }),
        );
        return runEpoch(started.checkpoint);
      }

      const snapshot = await dependencies.fetchRadar({
        token: auth.mainToken,
        now: () => new Date(attemptedAt),
        windowDays,
        refreshMode: effectivePlan.mode,
        lookbackDays: effectivePlan.lookbackDays,
      });
      const snapshotRecord = snapshot && typeof snapshot === 'object' ? snapshot : null;
      const snapshotAccountLogin = snapshotRecord && 'accountLogin' in snapshotRecord
        ? normalizedAccountLogin(snapshotRecord.accountLogin)
        : null;
      if (
        snapshotAccountLogin !== normalizedAccountLogin(accountLogin)
        || snapshot.windowDays !== windowDays
        || snapshot.refreshMode !== effectivePlan.mode
        || snapshot.lookbackDays !== effectivePlan.lookbackDays
      ) {
        throw new GitHubRadarError('invalid_response');
      }
      if (!(await requestIsCurrent(auth, windowDays))) return { published: false };
      await dependencies.store.commitSnapshot(snapshot, { credentialIdentity: identity(auth) });
      if (!(await requestIsCurrent(auth, windowDays))) return { published: false };
    } catch (error) {
      if (!(await requestIsCurrent(auth, windowDays))) return { published: false };
      if (
        error instanceof GitHubRadarError
        && (error.code === 'invalid_pagination' || error.code === 'invalid_response')
      ) {
        await dependencies.store.abandonReconciliation(accountLogin);
      }
      try {
        await dependencies.store.recordFailure(
          accountLogin,
          stableErrorCode(error),
          { nextAllowedAt: failureNextAllowedAt(error, attemptedAt) },
        );
      } catch {
        return { published: false };
      }
      if (!(await requestIsCurrent(auth, windowDays))) return { published: false };
      dependencies.broadcastChanged();
      return { published: false };
    }

    if (!(await requestIsCurrent(auth, windowDays))) return { published: false };
    dependencies.broadcastChanged();
    return { published: true };
  }

  function startFlight(
    requestedAuth: AuthSnapshot,
    windowDays: FollowingHistoryWindowDays,
    request: RadarRefreshRequest,
    requestedIdentity: string,
  ): Promise<RadarRefreshResult> {
    const operation = dependencies.runSerialized(
      () => performRefresh(requestedAuth, windowDays, request),
    );
    const promise = operation.then(async (outcome) => ({
      ...outcome,
      status: await statusForAuth(await readAuth(), false),
    }));
    inFlight = { identity: requestedIdentity, request, promise };
    void promise.finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    }).catch(() => {});
    return promise;
  }

  function queueFullAfter(
    current: { promise: Promise<RadarRefreshResult> },
    requestedIdentity: string,
  ): Promise<RadarRefreshResult> {
    if (pendingFull?.identity === requestedIdentity) return pendingFull.promise;

    let queuedPromise!: Promise<RadarRefreshResult>;
    queuedPromise = (async () => {
      try {
        await current.promise;
      } catch {
        // A failed refresh must not strand a requested full reconciliation.
      }
      if (inFlight?.promise === current.promise) inFlight = null;
      return refresh('full', { bypassPendingFull: true });
    })();
    pendingFull = { identity: requestedIdentity, promise: queuedPromise };
    void queuedPromise.finally(() => {
      if (pendingFull?.promise === queuedPromise) pendingFull = null;
    }).catch(() => {});
    return queuedPromise;
  }

  async function refresh(
    request: RadarRefreshRequest = 'auto',
    options: RadarRefreshOptions = {},
  ): Promise<RadarRefreshResult> {
    await reconcileAccount();
    const [requestedAuth, windowDays] = await Promise.all([readAuth(), readWindowDays()]);
    const requestedIdentity = JSON.stringify([identity(requestedAuth), windowDays]);
    if (
      !options.bypassPendingFull
      && pendingFull?.identity === requestedIdentity
    ) return pendingFull.promise;
    const current = inFlight;
    if (current) {
      if (
        current.identity === requestedIdentity
        && (request === 'auto' || current.request === 'full')
      ) return current.promise;
      if (request === 'full') return queueFullAfter(current, requestedIdentity);

      try {
        await current.promise;
      } catch {
        // A changed credential or history window gets its own isolated attempt.
      }
      if (inFlight === current) inFlight = null;
      return refresh(request, options);
    }

    return startFlight(requestedAuth, windowDays, request, requestedIdentity);
  }

  async function fullReconcile(): Promise<RadarRefreshResult> {
    return refresh('full');
  }

  async function dismiss(activityIds: readonly string[]): Promise<RadarStatus> {
    await reconcileAccount();
    const auth = await readAuth();
    if (!auth.accountLogin || !auth.mainToken) return statusForAuth(auth, inFlight !== null);
    await dependencies.runSerialized(async () => {
      if (!await sameCredentials(auth)) return;
      const changed = await dependencies.store.dismissActivities(auth.accountLogin!, activityIds);
      if (changed > 0) dependencies.broadcastChanged();
    });
    return statusForAuth(await readAuth(), inFlight !== null);
  }

  async function markSeen(activityIds: readonly string[]): Promise<RadarStatus> {
    await reconcileAccount();
    const auth = await readAuth();
    if (!auth.accountLogin || !auth.mainToken) return statusForAuth(auth, inFlight !== null);
    await dependencies.runSerialized(async () => {
      if (!await sameCredentials(auth)) return;
      const changed = await dependencies.store.markActivitiesSeen(auth.accountLogin!, activityIds);
      if (changed > 0) dependencies.broadcastChanged();
    });
    return statusForAuth(await readAuth(), inFlight !== null);
  }

  return {
    getStatus,
    query,
    refresh,
    fullReconcile,
    dismiss,
    markSeen,
    reconcileAccount,
    isRefreshing: () => inFlight !== null,
  };
}
