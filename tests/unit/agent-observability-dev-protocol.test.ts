import { describe, expect, it } from 'vitest';
import {
  DEV_TRACE_CONTROL_PORT,
  DEV_TRACE_EVIDENCE_PORT,
  validateDevTraceControlRequest,
  validateDevTraceEvidenceRequest,
} from '@/agent-observability';

describe('Agent observability development protocol', () => {
  it('keeps evidence and control on separate named ports with exact request unions', () => {
    expect(DEV_TRACE_EVIDENCE_PORT).not.toBe(DEV_TRACE_CONTROL_PORT);
    expect(validateDevTraceEvidenceRequest({
      version: 1,
      requestId: 'request-1',
      type: 'get_snapshot',
      scope: { kind: 'all_retained', id: null },
      cursor: null,
      maxBytes: 64 * 1024,
    }).type).toBe('get_snapshot');
    expect(validateDevTraceControlRequest({
      version: 1,
      requestId: 'request-2',
      type: 'run_scenario',
      scenarioId: 'overflow-then-success',
      controls: { delayMs: 0, contextWindow: 8_192 },
    }).type).toBe('run_scenario');
    expect(validateDevTraceControlRequest({
      version: 1,
      requestId: 'request-3',
      type: 'start_provider_monitor',
      state: {
        sessionId: 'provider-monitor:test',
        startedAt: 100,
        expiresAt: 200,
      },
    }).type).toBe('start_provider_monitor');
  });

  it('rejects unknown fields, arbitrary scenarios, oversized chunks, and weak clear commands', () => {
    expect(() => validateDevTraceEvidenceRequest({
      version: 1,
      requestId: 'request-1',
      type: 'subscribe',
      cursor: null,
      clear: true,
    })).toThrow(/unknown field/i);
    expect(() => validateDevTraceEvidenceRequest({
      version: 1,
      requestId: 'request-1',
      type: 'export',
      scope: { kind: 'all_retained', id: null },
      cursor: null,
      maxBytes: 1024 * 1024,
    })).toThrow(/outside the allowed range/i);
    expect(() => validateDevTraceEvidenceRequest({
      version: 1,
      requestId: 'request-small',
      type: 'get_snapshot',
      scope: { kind: 'all_retained', id: null },
      cursor: null,
      maxBytes: 1_024,
    })).toThrow(/outside the allowed range/i);
    expect(() => validateDevTraceEvidenceRequest({
      version: 1,
      requestId: 'x'.repeat(513),
      type: 'get_snapshot',
      scope: { kind: 'all_retained', id: null },
      cursor: null,
      maxBytes: 4_096,
    })).toThrow(/size limit/i);
    expect(() => validateDevTraceControlRequest({
      version: 1,
      requestId: 'request-2',
      type: 'run_scenario',
      scenarioId: 'arbitrary-provider-prompt',
      controls: { delayMs: 0, contextWindow: 8_192 },
    })).toThrow(/scenario ID/i);
    expect(() => validateDevTraceControlRequest({
      version: 1,
      requestId: 'request-3',
      type: 'clear_traces',
      confirmation: true,
    })).toThrow(/confirmation/i);
    expect(() => validateDevTraceControlRequest({
      version: 1,
      requestId: 'request-4',
      type: 'start_provider_monitor',
      state: {
        sessionId: 'invalid session',
        startedAt: 200,
        expiresAt: 100,
      },
    })).toThrow(/sessionId/i);
  });
});
