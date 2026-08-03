import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { resolveAgentModelContextCapability } from '@/agent-harness';
import { assertBgsmAgentContextCapabilityFeasible } from '@/bgsm-agent';

describe('BGSM Agent context policy feasibility', () => {
  it('accepts a practical declared window and rejects a working cap below fixed framing', () => {
    const capability = resolveAgentModelContextCapability({
      provider: 'custom-openai-compatible',
      model: 'custom-model',
      declaredContextWindow: 32_768,
    });
    assert.ok(capability);

    assert.doesNotThrow(() => assertBgsmAgentContextCapabilityFeasible({ capability }));
    assert.throws(() => assertBgsmAgentContextCapabilityFeasible({
      capability,
      workingContextWindow: 4_096,
    }), /AGENT_CONTEXT_CAPABILITY_INFEASIBLE/u);
  });
});
