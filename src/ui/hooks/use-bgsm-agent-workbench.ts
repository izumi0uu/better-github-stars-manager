import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  CONTROLLER_ID_PREFIX,
  type ControllerId,
} from '@/bgsm-agent/identity';
import {
  canContinueOrganizeJobRun,
  createAgentWorkbenchState,
  displayedAnalyzedRepositoryCount,
  PREFLIGHT_INCOMPLETE_COPY,
  reduceAgentWorkbench,
  type WorkbenchConversationAnchor,
} from '@/ui/agent-workbench-state';
import type { BgsmAgentOrganizeLibraryHandoff } from '@/bgsm-agent/tools';
import {
  validateBgsmOrganizeJobDeliveryEnvelope,
  validateBgsmOrganizeJobMessageIdentity,
  type BgsmOrganizeJobClientMessage,
} from '@/utils/messaging';

type DeferredOrganizeHandoffCommand = Extract<
  BgsmOrganizeJobClientMessage,
  {
    type:
      | 'requestBgsmOrganizeJobPreflight'
      | 'startBgsmOrganizeJob'
      | 'cancelBgsmOrganizeJobPreflight';
  }
>;

export function useBgsmAgentWorkbench(
  onAuthoritativeDataChanged?: () => void,
  sharedSessionId?: string,
) {
  const controllerIdRef = useRef<ControllerId>(createControllerId());
  const sessionIdRef = useRef(sharedSessionId ?? `organize-session:${createNonce()}`);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const restoreRunAfterPreflightCancelRef = useRef(false);
  const agentAutoStartRequestIdRef = useRef<string | null>(null);
  const agentHandoffAuthorityRef = useRef(0);
  const deferredHandoffCommandRef = useRef<DeferredOrganizeHandoffCommand | null>(null);
  const onAuthoritativeDataChangedRef = useRef(onAuthoritativeDataChanged);
  onAuthoritativeDataChangedRef.current = onAuthoritativeDataChanged;
  const [state, dispatch] = useReducer(
    reduceAgentWorkbench,
    undefined,
    () => createAgentWorkbenchState(controllerIdRef.current, sessionIdRef.current),
  );
  const snapshotRef = useRef(state.snapshot);
  snapshotRef.current = state.snapshot;
  const stateRef = useRef(state);
  stateRef.current = state;
  const dispatchTracked = useCallback((action: Parameters<typeof reduceAgentWorkbench>[1]) => {
    stateRef.current = reduceAgentWorkbench(stateRef.current, action);
    dispatch(action);
  }, []);
  const displayedProcessed = displayedAnalyzedRepositoryCount(state);

  const tryPost = useCallback((message: BgsmOrganizeJobClientMessage): boolean => {
    validateBgsmOrganizeJobMessageIdentity(message);
    const port = portRef.current;
    if (!port) return false;
    try {
      port.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }, []);

  const post = useCallback((message: BgsmOrganizeJobClientMessage) => {
    if (!tryPost(message)) throw new Error('Cubby is not connected.');
  }, [tryPost]);

  const postOrDeferHandoff = useCallback((message: DeferredOrganizeHandoffCommand) => {
    deferredHandoffCommandRef.current = message;
    if (tryPost(message)) deferredHandoffCommandRef.current = null;
  }, [tryPost]);

  useEffect(() => {
    const nextSessionId = sharedSessionId ?? sessionIdRef.current;
    if (nextSessionId !== sessionIdRef.current) {
      controllerIdRef.current = createControllerId();
      sessionIdRef.current = nextSessionId;
      restoreRunAfterPreflightCancelRef.current = false;
      agentAutoStartRequestIdRef.current = null;
      agentHandoffAuthorityRef.current += 1;
      deferredHandoffCommandRef.current = null;
      const rebound = createAgentWorkbenchState(controllerIdRef.current, nextSessionId);
      stateRef.current = rebound;
      snapshotRef.current = null;
      dispatch({
        type: 'session_rebound',
        controllerId: controllerIdRef.current,
        sessionId: nextSessionId,
      });
    }
    const controllerId = controllerIdRef.current;
    const sessionId = sessionIdRef.current;
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.connect) return;
    let disposed = false;
    let activePort: chrome.runtime.Port | null = null;
    let detachCurrent = () => {};
    const retiringPorts = new Set<chrome.runtime.Port>();

    const connect = (retiringPort: chrome.runtime.Port | null = null) => {
      if (disposed) return;
      const port = runtime.connect({ name: 'bgsm-agent-organize-job' });
      let connectionEpochId: string | null = null;
      let nextDeliverySequence = 0;
      let reconnecting = false;
      let predecessor = retiringPort;
      activePort = port;
      portRef.current = port;
      dispatch({ type: 'transport_connected' });

      const releasePredecessor = () => {
        const stalePort = predecessor;
        predecessor = null;
        if (!stalePort) return;
        retiringPorts.delete(stalePort);
        try {
          stalePort.disconnect();
        } catch {
          // Replacement ownership is already acknowledged; stale cleanup is best-effort.
        }
      };

      const reconnectFromTransport = () => {
        if (disposed || activePort !== port || reconnecting) return;
        reconnecting = true;
        detachPort();
        activePort = null;
        if (portRef.current === port) portRef.current = null;
        retiringPorts.add(port);
        // A failed deferred handoff must survive the reconnect. Schedule the
        // replacement asynchronously so a throwing Port cannot recurse through
        // connect() synchronously and overflow the worker/UI stack.
        queueMicrotask(() => {
          if (!disposed) connect(port);
        });
      };

      const onMessage = (delivery: unknown) => {
        if (disposed || activePort !== port) return;
        try {
          validateBgsmOrganizeJobDeliveryEnvelope(delivery);
          if (connectionEpochId === null) {
            if (delivery.deliverySequence !== 0) {
              reconnectFromTransport();
              return;
            }
            connectionEpochId = delivery.connectionEpochId;
          } else if (delivery.connectionEpochId !== connectionEpochId) {
            reconnectFromTransport();
            return;
          }
          if (delivery.deliverySequence < nextDeliverySequence) return;
          if (delivery.deliverySequence > nextDeliverySequence) {
            reconnectFromTransport();
            return;
          }
          nextDeliverySequence += 1;
          releasePredecessor();
        } catch {
          reconnectFromTransport();
          return;
        }

        try {
          const message = delivery.message;
          validateBgsmOrganizeJobMessageIdentity(message);
          const action = {
            type: 'server_message' as const,
            message,
            authoritative: delivery.deliveryKind === 'authoritative_snapshot',
          };
          const currentState = stateRef.current;
          const nextState = reduceAgentWorkbench(currentState, action);
          stateRef.current = nextState;
          snapshotRef.current = nextState.snapshot;
          dispatch(action);
          if (
            message.type === 'bgsmOrganizeJobState' &&
            message.presentation.status === 'completed' &&
            currentState.organizeJob?.status !== 'completed'
          ) {
            onAuthoritativeDataChangedRef.current?.();
          }
        } catch {
          // A structurally valid but stale domain message is safe to ignore.
        }
      };
      const onDisconnect = () => {
        if (disposed || activePort !== port || reconnecting) return;
        reconnecting = true;
        detachPort();
        activePort = null;
        if (portRef.current === port) portRef.current = null;
        releasePredecessor();
        dispatch({ type: 'transport_disconnected' });
        queueMicrotask(connect);
      };
      const detachPort = () => {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
      };
      detachCurrent = detachPort;
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);

      const deferredHandoff = deferredHandoffCommandRef.current;
      const currentState = stateRef.current;
      const snapshot = snapshotRef.current;
      if (deferredHandoff) {
        try {
          validateBgsmOrganizeJobMessageIdentity(deferredHandoff);
          port.postMessage(deferredHandoff);
          deferredHandoffCommandRef.current = null;
        } catch {
          reconnectFromTransport();
        }
      } else if (currentState.organizeJob) {
        const request: BgsmOrganizeJobClientMessage = {
          type: 'requestBgsmActiveOrganizeJob',
          controllerId,
          sessionId,
        };
        validateBgsmOrganizeJobMessageIdentity(request);
        port.postMessage(request);
      } else if (snapshot) {
        const request: BgsmOrganizeJobClientMessage = {
          type: 'requestBgsmOrganizeJobSnapshot',
          controllerId,
          sessionId,
          runId: snapshot.runId,
          generation: snapshot.generation,
        };
        validateBgsmOrganizeJobMessageIdentity(request);
        port.postMessage(request);
      } else {
        const request: BgsmOrganizeJobClientMessage = {
          type: 'requestBgsmActiveOrganizeJob',
          controllerId,
          sessionId,
        };
        validateBgsmOrganizeJobMessageIdentity(request);
        port.postMessage(request);
      }
    };
    connect();

    return () => {
      disposed = true;
      detachCurrent();
      const port = activePort;
      activePort = null;
      portRef.current = null;
      if (!port) return;
      try {
        port.postMessage({
          type: 'disconnectBgsmOrganizeJob',
          controllerId,
          sessionId,
        } satisfies BgsmOrganizeJobClientMessage);
      } catch {
        // The worker may already be gone; disconnect remains best-effort.
      }
      port.disconnect();
      for (const retiringPort of retiringPorts) {
        try {
          retiringPort.disconnect();
        } catch {
          // A retired replacement predecessor may already be closed.
        }
      }
      retiringPorts.clear();
    };
  }, [sharedSessionId]);

  const requestOrganizeReviewPage = useCallback((rowOffset: number) => {
    const job = stateRef.current.organizeJob;
    if (!job || job.status !== 'review') return;
    const requestId = `organize-review:${createNonce()}`;
    dispatchTracked({ type: 'organize_review_page_requested', requestId });
    post({
      type: 'requestBgsmOrganizeReviewPage',
      controllerId: controllerIdRef.current,
      sessionId: sessionIdRef.current,
      runId: job.runId,
      generation: job.generation,
      requestId,
      jobId: job.jobId,
      rowOffset,
      limit: 100,
    });
  }, [dispatchTracked, post]);

  const requestOrganizeReceiptPage = useCallback((
    rowOffset: number,
    filter: 'all' | 'changed_or_failed' = 'all',
  ) => {
    const job = stateRef.current.organizeJob;
    if (!job?.apply || job.status !== 'completed') return;
    const requestId = `organize-receipt:${createNonce()}`;
    dispatchTracked({ type: 'organize_receipt_page_requested', requestId });
    post({
      type: 'requestBgsmOrganizeReceiptPage',
      controllerId: controllerIdRef.current,
      sessionId: sessionIdRef.current,
      runId: job.runId,
      generation: job.generation,
      requestId,
      jobId: job.jobId,
      applyId: job.apply.applyId,
      rowOffset,
      limit: 100,
      filter,
    });
  }, [dispatchTracked, post]);

  useEffect(() => {
    const job = state.organizeJob;
    if (
      state.transport !== 'connected' ||
      !job ||
      job.status !== 'review' ||
      state.organizeReviewRequestId !== null ||
      (state.organizeReviewPage?.jobId === job.jobId &&
        state.organizeReviewPage.revision === job.revision)
    ) return;
    requestOrganizeReviewPage(state.organizeReviewPage?.rowOffset ?? 0);
  }, [
    requestOrganizeReviewPage,
    state.organizeJob,
    state.organizeReviewPage,
    state.organizeReviewRequestId,
    state.transport,
  ]);

  useEffect(() => {
    const job = state.organizeJob;
    if (
      state.transport !== 'connected' ||
      !job?.apply ||
      job.status !== 'completed' ||
      state.organizeReceiptRequestId !== null ||
      state.organizeReceiptPage?.applyId === job.apply.applyId
    ) return;
    requestOrganizeReceiptPage(0, 'all');
  }, [
    requestOrganizeReceiptPage,
    state.organizeJob,
    state.organizeReceiptPage,
    state.organizeReceiptRequestId,
    state.transport,
  ]);

  const requestPreflight = useCallback((
    taskInstruction: string,
    conversationAnchor: WorkbenchConversationAnchor = {
      messageId: null,
      createdAt: Date.now(),
    },
  ) => {
    const requestId = `preflight-request:${createNonce()}`;
    const normalizedInstruction = taskInstruction.trim();
    restoreRunAfterPreflightCancelRef.current = false;
    dispatchTracked({
      type: 'preflight_requested',
      requestId,
      taskInstruction: normalizedInstruction,
      conversationAnchor,
    });
    postOrDeferHandoff({
      type: 'requestBgsmOrganizeJobPreflight',
      controllerId: controllerIdRef.current,
      sessionId: sessionIdRef.current,
      requestId,
      taskInstruction: normalizedInstruction,
    });
    return requestId;
  }, [dispatchTracked, postOrDeferHandoff]);

  const restartWholeLibrary = useCallback((taskInstruction: string) => {
    const requestId = `preflight-request:${createNonce()}`;
    const normalizedInstruction = taskInstruction.trim();
    agentHandoffAuthorityRef.current += 1;
    restoreRunAfterPreflightCancelRef.current = true;
    dispatchTracked({
      type: 'whole_library_restart_requested',
      requestId,
      taskInstruction: normalizedInstruction,
      conversationAnchor: stateRef.current.conversationAnchor ?? {
        messageId: null,
        createdAt: Date.now(),
      },
    });
    postOrDeferHandoff({
      type: 'requestBgsmOrganizeJobPreflight',
      controllerId: controllerIdRef.current,
      sessionId: sessionIdRef.current,
      requestId,
      taskInstruction: normalizedInstruction,
    });
    return requestId;
  }, [dispatchTracked, postOrDeferHandoff]);

  const confirmPreflight = useCallback(() => {
    const preflight = stateRef.current.preflight;
    if (
      preflight?.status !== 'ready'
      || !preflight.preflightToken
      || !preflight.taskInstruction
    ) {
      dispatchTracked({
        type: 'preflight_start_failed',
        message: PREFLIGHT_INCOMPLETE_COPY,
      });
      return;
    }
    dispatchTracked({ type: 'preflight_start_requested' });
    postOrDeferHandoff({
      type: 'startBgsmOrganizeJob',
      controllerId: controllerIdRef.current,
      sessionId: sessionIdRef.current,
      requestId: preflight.requestId,
      preflightToken: preflight.preflightToken,
      taskInstruction: preflight.taskInstruction,
    });
  }, [dispatchTracked, postOrDeferHandoff]);

  const startWholeLibraryFromAgent = useCallback((
    taskInstruction: string,
    conversationAnchor?: WorkbenchConversationAnchor,
  ) => {
    const current = stateRef.current;
    const preflight = current.preflight;
    if (preflight?.status === 'ready') {
      agentAutoStartRequestIdRef.current = null;
      confirmPreflight();
      return true;
    }
    if (preflight?.status === 'requesting') {
      agentAutoStartRequestIdRef.current = preflight.requestId;
      return true;
    }
    if (preflight?.status === 'starting') return true;
    if (
      current.organizeJob
      && ['analyzing', 'analysis_blocked', 'review', 'apply_sealed', 'applying', 'paused']
        .includes(current.organizeJob.status)
    ) return false;

    const requestId = requestPreflight(taskInstruction, conversationAnchor);
    agentAutoStartRequestIdRef.current = requestId;
    return true;
  }, [confirmPreflight, requestPreflight]);

  const captureAgentHandoffAuthority = useCallback(
    () => agentHandoffAuthorityRef.current,
    [],
  );

  const applyAgentHandoff = useCallback((
    handoff: BgsmAgentOrganizeLibraryHandoff,
    authority: number,
    conversationAnchor: WorkbenchConversationAnchor,
  ): boolean => {
    if (authority !== agentHandoffAuthorityRef.current) return false;
    agentHandoffAuthorityRef.current += 1;
    if (handoff.action === 'start_analysis') {
      return startWholeLibraryFromAgent(handoff.instruction, conversationAnchor);
    }
    requestPreflight(handoff.instruction, conversationAnchor);
    return true;
  }, [requestPreflight, startWholeLibraryFromAgent]);

  useEffect(() => {
    const requestId = agentAutoStartRequestIdRef.current;
    if (!requestId) return;
    const preflight = state.preflight;
    if (!preflight) {
      if (state.error) agentAutoStartRequestIdRef.current = null;
      return;
    }
    if (preflight.requestId !== requestId) {
      agentAutoStartRequestIdRef.current = null;
      return;
    }
    if (preflight.status === 'no_work') {
      agentAutoStartRequestIdRef.current = null;
      return;
    }
    if (preflight.status !== 'ready') return;
    agentAutoStartRequestIdRef.current = null;
    confirmPreflight();
  }, [confirmPreflight, state.error, state.preflight]);

  const cancelPreflight = useCallback(() => {
    const requestId = state.preflight?.requestId;
    const restoreRun = restoreRunAfterPreflightCancelRef.current;
    restoreRunAfterPreflightCancelRef.current = false;
    agentAutoStartRequestIdRef.current = null;
    agentHandoffAuthorityRef.current += 1;
    const pendingWasUnsentRequest = deferredHandoffCommandRef.current?.type ===
      'requestBgsmOrganizeJobPreflight'
      && deferredHandoffCommandRef.current.requestId === requestId;
    if (deferredHandoffCommandRef.current?.requestId === requestId) {
      deferredHandoffCommandRef.current = null;
    }
    if (requestId && !pendingWasUnsentRequest) {
      postOrDeferHandoff({
        type: 'cancelBgsmOrganizeJobPreflight',
        controllerId: controllerIdRef.current,
        sessionId: sessionIdRef.current,
        requestId,
      });
    }
    dispatchTracked({ type: 'preflight_cancelled' });
    if (restoreRun) {
      post({
        type: 'requestBgsmActiveOrganizeJob',
        controllerId: controllerIdRef.current,
        sessionId: sessionIdRef.current,
      });
    }
  }, [dispatchTracked, post, postOrDeferHandoff, state.preflight?.requestId]);

  const stop = useCallback(() => {
    const identity = !state.organizeJob
      ? state.snapshot
      : !state.snapshot || state.organizeJob.generation >= state.snapshot.generation
        ? state.organizeJob
        : state.snapshot;
    if (!identity) return;
    post({
      type: 'stopBgsmOrganizeJob',
      controllerId: controllerIdRef.current,
      sessionId: sessionIdRef.current,
      runId: identity.runId,
      generation: identity.generation,
    });
  }, [post, state.organizeJob, state.snapshot]);

  const continueRemaining = useCallback(() => {
    const snapshot = state.snapshot;
    const continuationCursor = snapshot?.continuationCursor;
    if (
      !snapshot ||
      !continuationCursor ||
      (
        state.organizeJob
        && (
          state.organizeJob.runId !== snapshot.runId
          || state.organizeJob.generation !== snapshot.generation
        )
      ) ||
      !canContinueOrganizeJobRun(snapshot)
    ) return;
    dispatch({ type: 'continue_requested' });
    post({
      type: 'continueBgsmOrganizeJob',
      controllerId: controllerIdRef.current,
      sessionId: sessionIdRef.current,
      runId: snapshot.runId,
      generation: snapshot.generation,
      continuationCursor,
    });
  }, [post, state.organizeJob, state.snapshot]);

  const discardBlockedRun = useCallback(() => {
    const current = stateRef.current;
    const snapshot = current.snapshot;
    const identity = current.organizeJob?.status === 'analysis_blocked'
      ? current.organizeJob
      : snapshot?.state === 'analysis_blocked'
        ? snapshot
        : null;
    if (!identity) return;
    post({
      type: 'stopBgsmOrganizeJob',
      controllerId: identity.controllerId,
      sessionId: identity.sessionId,
      runId: identity.runId,
      generation: identity.generation,
    });
    dispatch({ type: 'clear_terminal' });
  }, [post]);

  const discardReview = useCallback(() => {
    const current = stateRef.current;
    const identity = current.organizeJob?.status === 'review'
      ? current.organizeJob
      : current.snapshot?.state === 'review'
        ? current.snapshot
        : null;
    if (!identity) return;
    post({
      type: 'stopBgsmOrganizeJob',
      controllerId: identity.controllerId,
      sessionId: identity.sessionId,
      runId: identity.runId,
      generation: identity.generation,
    });
    dispatch({ type: 'clear_terminal' });
  }, [post]);

  const toggleProposalRow = useCallback((proposalRowId: string) => {
    const job = state.organizeJob;
    const page = state.organizeReviewPage;
    const row = page?.rows.find((candidate) => candidate.proposalRowId === proposalRowId);
    if (job?.status === 'review' && page && row) {
      const requestId = `organize-selection:${createNonce()}`;
      dispatchTracked({ type: 'organize_review_page_requested', requestId });
      post({
        type: 'updateBgsmOrganizeSelection',
        controllerId: controllerIdRef.current,
        sessionId: sessionIdRef.current,
        runId: job.runId,
        generation: job.generation,
        requestId,
        jobId: job.jobId,
        expectedRevision: job.revision,
        rowOffset: page.rowOffset,
        selections: [{ position: row.position, selected: !row.selected }],
      });
      return;
    }
  }, [dispatchTracked, post, state.organizeJob, state.organizeReviewPage]);

  const setAllProposalRowsSelected = useCallback((selected: boolean) => {
    const job = state.organizeJob;
    if (job?.status === 'review') {
      const requestId = `organize-selection-all:${createNonce()}`;
      dispatchTracked({ type: 'organize_review_page_requested', requestId });
      post({
        type: 'setAllBgsmOrganizeSelections',
        controllerId: controllerIdRef.current,
        sessionId: sessionIdRef.current,
        runId: job.runId,
        generation: job.generation,
        requestId,
        jobId: job.jobId,
        expectedRevision: job.revision,
        rowOffset: state.organizeReviewPage?.rowOffset ?? 0,
        selected,
      });
      return;
    }
  }, [dispatchTracked, post, state.organizeJob, state.organizeReviewPage?.rowOffset]);

  const applySelected = useCallback(() => {
    const organizeJob = state.organizeJob;
    if (organizeJob?.status === 'review') {
      if (organizeJob.selectedRepositories === 0) return;
      post({
        type: 'applyBgsmOrganizeSelection',
        controllerId: controllerIdRef.current,
        sessionId: sessionIdRef.current,
        runId: organizeJob.runId,
        generation: organizeJob.generation,
        jobId: organizeJob.jobId,
        expectedRevision: organizeJob.revision,
      });
      return;
    }
  }, [post, state.organizeJob]);

  const resumeOrganizeApply = useCallback(() => {
    const job = state.organizeJob;
    if (!job?.apply || job.status !== 'paused') return;
    post({
      type: 'resumeBgsmOrganizeApply',
      controllerId: controllerIdRef.current,
      sessionId: sessionIdRef.current,
      runId: job.runId,
      generation: job.generation,
      jobId: job.jobId,
      expectedRevision: job.revision,
    });
  }, [post, state.organizeJob]);

  const clearTerminal = useCallback(() => {
    agentHandoffAuthorityRef.current += 1;
    deferredHandoffCommandRef.current = null;
    const job = stateRef.current.organizeJob;
    if (job?.status === 'completed' && job.apply) {
      post({
        type: 'dismissBgsmOrganizeReceipt',
        controllerId: controllerIdRef.current,
        sessionId: sessionIdRef.current,
        runId: job.runId,
        generation: job.generation,
        jobId: job.jobId,
        applyId: job.apply.applyId,
      });
    }
    dispatch({ type: 'clear_terminal' });
  }, [post]);

  return useMemo(() => ({
    state,
    displayedProcessed,
    requestPreflight,
    captureAgentHandoffAuthority,
    applyAgentHandoff,
    startWholeLibraryFromAgent,
    restartWholeLibrary,
    confirmPreflight,
    cancelPreflight,
    stop,
    continueRemaining,
    discardBlockedRun,
    discardReview,
    toggleProposalRow,
    setAllProposalRowsSelected,
    applySelected,
    resumeOrganizeApply,
    requestOrganizeReviewPage,
    requestOrganizeReceiptPage,
    clearTerminal,
  }), [
    cancelPreflight,
    clearTerminal,
    confirmPreflight,
    continueRemaining,
    discardBlockedRun,
    discardReview,
    applySelected,
    displayedProcessed,
    requestPreflight,
    captureAgentHandoffAuthority,
    applyAgentHandoff,
    startWholeLibraryFromAgent,
    requestOrganizeReceiptPage,
    requestOrganizeReviewPage,
    resumeOrganizeApply,
    restartWholeLibrary,
    setAllProposalRowsSelected,
    state,
    stop,
    toggleProposalRow,
  ]);
}

function createControllerId(): ControllerId {
  return `${CONTROLLER_ID_PREFIX}${createNonce()}` as ControllerId;
}

function createNonce(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
