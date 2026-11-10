import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { BackgroundRequest, BackgroundResponse, BackgroundResult } from '@/runtime/background-command';
import type { ManagerRuntime, ManagerSurfaceBadgeCounts } from '@/runtime/manager-runtime';
import type { RecommendationPresentation } from '@/recommendations/recommendation-projector';
import type { RecommendationQueryResponse } from '@/recommendations/recommendation-model';
import type { StarsQueryResult } from '@/stars/stars-query';
import type { SyncStatus } from '@/utils/messaging';
import { BackgroundCallError, bgCall } from '@/utils/messaging';

const sendMessage = vi.fn();

afterEach(() => {
  sendMessage.mockReset();
  vi.unstubAllGlobals();
});

describe('background command bridge', () => {
  it('sends the existing command envelope and unwraps only its data', async () => {
    const data = { favorite: true };
    sendMessage.mockResolvedValue({ ok: true, data });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    await expect(bgCall('setFavorite', { full_name: 'octocat/tool', favorite: true })).resolves.toBe(data);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'setFavorite', full_name: 'octocat/tool', favorite: true,
    });
  });

  it('preserves null, false, zero, and absent data rather than inventing a result', async () => {
    sendMessage
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: true, data: false })
      .mockResolvedValueOnce({ ok: true, data: 0 })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    await expect(bgCall('markWatchInboxLoaded')).resolves.toBeNull();
    await expect(bgCall('dismissAgentSessionRetry', { sessionId: 'session-a', turnAttemptId: 'attempt-a' })).resolves.toBe(false);
    await expect(bgCall('discardDamagedAgentSessionRecovery', { sessionId: 'session-a' })).resolves.toBe(0);
    await expect(bgCall('setNotes', { full_name: 'octocat/tool', notes: '' })).resolves.toBeUndefined();
  });

  it('preserves localized error text, stable code, and structured details', async () => {
    const details = { status: 403 };
    sendMessage.mockResolvedValue({ ok: false, error: 'Permission denied', code: 'permission_denied', details });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const error = await bgCall('getWatchSubjectDetail', { threadId: '123' }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(BackgroundCallError);
    expect(error).toMatchObject({ message: 'Permission denied', code: 'permission_denied', details });
  });

  it('does not replace a transport rejection with a success or background failure', async () => {
    const failure = new Error('worker unavailable');
    sendMessage.mockRejectedValue(failure);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    await expect(bgCall('getStatus')).rejects.toBe(failure);
  });

  it('associates request fields, result types, and manager recommendation presentation at compile time', () => {
    expectTypeOf<BackgroundResult<'query'>>().toEqualTypeOf<StarsQueryResult>();
    expectTypeOf<BackgroundResult<'getStatus'>>().toEqualTypeOf<SyncStatus>();
    expectTypeOf<BackgroundResult<'queryManagerSurfaceBadges'>>().toEqualTypeOf<ManagerSurfaceBadgeCounts>();
    expectTypeOf<BackgroundResult<'queryRecommendations'>>().toEqualTypeOf<RecommendationQueryResponse>();
    expectTypeOf<RecommendationQueryResponse['recommendations'][number]>().toEqualTypeOf<RecommendationPresentation>();
    expectTypeOf<ManagerRuntime['queryRecommendations']>().toEqualTypeOf<() => Promise<RecommendationQueryResponse>>();

    // Checked by the project TypeScript build; invalid calls must never reach Chrome.
    if (false) {
      expectTypeOf(bgCall('getStatus')).toEqualTypeOf<Promise<SyncStatus>>();
      expectTypeOf(bgCall('setFavorite', { full_name: 'octocat/tool', favorite: false }))
        .toEqualTypeOf<Promise<{ favorite: boolean }>>();
      expectTypeOf(bgCall('queryRecommendations')).toEqualTypeOf<Promise<RecommendationQueryResponse>>();
      void bgCall('syncFull');
      void bgCall('syncFull', { includeOwnedPublic: false });
      void bgCall('openOptions', { section: 'watch' });
      // @ts-expect-error Required payload cannot be omitted.
      void bgCall('setFavorite');
      // @ts-expect-error Another command's payload cannot select a different inferred command.
      void bgCall('setFavorite', { threadId: '123' });
      // @ts-expect-error Runtime validation is not a substitute for caller field types.
      void bgCall('queryWatchInbox', { unreadOnly: 'yes' });
      // @ts-expect-error Payload-free commands cannot carry arbitrary fields.
      void bgCall('getStatus', { favorite: true });
      // @ts-expect-error Only declared commands may use the ordinary bridge.
      void bgCall('notACommand');
      // @ts-expect-error A broad string is not a command escape hatch.
      void bgCall('getStatus' as string);
      // @ts-expect-error Callers cannot choose the result type.
      void bgCall<SyncStatus>('getStatus');
      // @ts-expect-error Session payloads still follow the dedicated request contract.
      void bgCall('deleteAgentSession');
      // @ts-expect-error Dispatcher success data must match its narrowed command.
      const wrongResponse: BackgroundResponse<'setFavorite'> = { ok: true, data: { removed: 1 } };
      // @ts-expect-error Requests retain discriminant/payload association.
      const wrongRequest: BackgroundRequest = { type: 'setFavorite', threadId: '123' };
      void wrongResponse;
      void wrongRequest;
    }
  });
});
