import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevTraceDB } from '@/agent-observability';
import {
  runDevTraceScenario,
} from '@/agent-observability/scenario-lab';
import type { DevTraceScenarioId } from '@/agent-observability/dev-protocol';
import type { DevTraceEvent } from '@/agent-observability/contracts';

const databases: DevTraceDB[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(databases.splice(0).map(async (db) => {
    db.close();
    await db.delete();
  }));
});

describe('Agent observability Scenario Lab', () => {
  const cases = [
    ['small-window-multiple-tools', ['tool_completed', 'continuation_finished'], 'completed'],
    ['overflow-then-success', ['provider_error', 'context_reduction_finished', 'continuation_finished'], 'completed'],
    ['malformed-summary-fallback', ['context_reduction_finished', 'provider_finished'], 'completed'],
    ['cancel-during-compaction', ['context_reduction_finished', 'root_cancelled'], 'cancelled'],
    ['agent-port-disconnect', ['port_disconnected', 'delivery_state'], 'completed'],
    ['organize-cross-batch-recovery', ['organize_generation_state', 'organize_durable_state'], 'completed'],
    ['organize-cancel-during-apply', ['organize_apply_chunk', 'root_cancelled'], 'cancelled'],
    ['organize-port-reconnect', ['organize_durable_state', 'organize_review_state'], 'completed'],
  ] as const satisfies readonly [DevTraceScenarioId, readonly string[], string][];

  for (const [scenarioId, expectedKinds, terminalState] of cases) {
    it(`runs ${scenarioId} through isolated trace dependencies`, async () => {
      const db = new DevTraceDB(`bgsm-agent-scenario-${scenarioId}-${crypto.randomUUID()}`);
      databases.push(db);
      let id = 0;
      let wallTime = 1_000;
      const fetch = vi.fn(() => {
        throw new Error('Scenario Lab must not use the network.');
      });
      vi.stubGlobal('fetch', fetch);

      const result = await runDevTraceScenario({
        scenarioId,
        controls: { delayMs: 0, contextWindow: 8_192 },
      }, {
        dev: true,
        db,
        now: () => ++wallTime,
        monotonicNow: () => wallTime,
        randomId: () => `fixture-${++id}`,
        sleep: async () => {},
      });

      expect(result.scenarioId).toBe(scenarioId);
      expect(result.rootOperationIds).toHaveLength(1);
      const rootOperationId = result.rootOperationIds[0]!;
      const root = await db.roots.get(rootOperationId);
      const events = await db.events
        .where('rootOperationId')
        .equals(rootOperationId)
        .sortBy('sequence');
      const kinds = events.map((event) => event.kind);
      expect(root?.terminalState).toBe(terminalState);
      for (const kind of expectedKinds) expect(kinds).toContain(kind);
      assertScenarioEvidence(scenarioId, events);
      expect(kinds.at(-1)).toBe('root_terminal');
      expect(fetch).not.toHaveBeenCalled();
      expect(events.some((event) => event.kind === 'tool_write_outcome')).toBe(false);
      expect(JSON.stringify(events)).not.toMatch(
        /SCENARIO_PRIVATE|Authorization|Bearer|apiKey|baseUrl|headers/u,
      );
    });
  }

  it('rejects release access, arbitrary fixture IDs, and unbounded controls', async () => {
    const input = {
      scenarioId: 'small-window-multiple-tools' as const,
      controls: { delayMs: 0, contextWindow: 8_192 },
    };
    await expect(runDevTraceScenario(input, { dev: false })).rejects.toThrow(/development builds/i);
    await expect(runDevTraceScenario({
      ...input,
      scenarioId: 'arbitrary-provider-prompt' as DevTraceScenarioId,
    }, { dev: true })).rejects.toThrow(/Scenario ID/i);
    await expect(runDevTraceScenario({
      ...input,
      controls: { delayMs: 30_001, contextWindow: 8_192 },
    }, { dev: true })).rejects.toThrow(/delayMs/i);
  });
});

function assertScenarioEvidence(
  scenarioId: DevTraceScenarioId,
  events: readonly DevTraceEvent[],
): void {
  const dataFor = (kind: string) => events
    .filter((event) => event.kind === kind)
    .map((event) => event.data as Record<string, unknown>);
  switch (scenarioId) {
    case 'small-window-multiple-tools':
      expect(dataFor('tool_completed')).toHaveLength(2);
      expect(dataFor('continuation_finished')).toHaveLength(2);
      return;
    case 'overflow-then-success':
      expect(dataFor('provider_error')).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'context_overflow', overflow: true }),
      ]));
      return;
    case 'malformed-summary-fallback':
      expect(dataFor('context_reduction_finished')).toEqual(expect.arrayContaining([
        expect.objectContaining({ outcome: 'fallback' }),
      ]));
      return;
    case 'cancel-during-compaction':
      expect(dataFor('context_reduction_finished')).toEqual(expect.arrayContaining([
        expect.objectContaining({ outcome: 'cancelled' }),
      ]));
      return;
    case 'agent-port-disconnect':
      expect(dataFor('delivery_state')).toEqual(expect.arrayContaining([
        expect.objectContaining({ deliveryKind: 'replay', deliverySequence: 1 }),
      ]));
      return;
    case 'organize-cross-batch-recovery':
      expect(dataFor('organize_durable_state')).toEqual(expect.arrayContaining([
        expect.objectContaining({ observation: 'gap_reconciled', missingFromRevision: 2, missingToRevision: 2 }),
      ]));
      return;
    case 'organize-cancel-during-apply':
      expect(dataFor('organize_apply_state')).toEqual(expect.arrayContaining([
        expect.objectContaining({ executionId: null, revision: 2, state: 'pause_requested' }),
        expect.objectContaining({ executionId: null, revision: 3, state: 'paused' }),
      ]));
      return;
    case 'organize-port-reconnect':
      expect(dataFor('organize_durable_state')).toEqual(expect.arrayContaining([
        expect.objectContaining({ observation: 'duplicate', revision: 4 }),
        expect.objectContaining({ observation: 'gap_reconciled', revision: 6 }),
      ]));
  }
}
