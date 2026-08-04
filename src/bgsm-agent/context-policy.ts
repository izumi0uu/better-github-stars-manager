import {
  preflightContextRequest,
  resolveContextBudgetPolicy,
  toToolDefinition,
} from '@/agent-harness';
import type { AgentModelContextCapability } from '@/types';
import { AGENT_CONTEXT_CAPABILITY_INFEASIBLE } from '@/api/errors';
import { BGSM_AGENT_MAX_OUTPUT_TOKENS } from './compaction';
import { buildBgsmAgentSystemPrompt, createBgsmAgentPromptScope } from './instructions';
import { createBgsmAgentToolRegistry } from './tools';

const MIN_FEASIBLE_CURRENT_PROMPT_TOKENS = 1_024;
const CONTEXT_CAPABILITY_PREFLIGHT_SCOPE = createBgsmAgentPromptScope({
  kind: 'selected_repository',
  label: 'owner/repository',
  repositoryIds: ['owner/repository'],
});

export function assertBgsmAgentContextCapabilityFeasible(input: Readonly<{
  capability: AgentModelContextCapability;
  workingContextWindow?: number | null;
}>): void {
  const policy = resolveContextBudgetPolicy({
    capability: input.capability,
    configuredWorkingWindow: input.workingContextWindow,
    requestedOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
  });
  const toolRegistry = createBgsmAgentToolRegistry({
    repositoryScope: [],
    scopeFingerprint: 'context-capability-preflight',
    enableRepositoryCodeSearch: true,
    enableRepositoryNotes: true,
    enableOrganizeLibraryHandoff: true,
    requestOrganizeLibraryHandoff: () => ({ status: 'accepted' }),
  });
  const tools = toolRegistry.getActiveTools().map(toToolDefinition);
  const preflight = preflightContextRequest({
    messages: [
      {
        role: 'system',
        content: buildBgsmAgentSystemPrompt({
          conversationScope: CONTEXT_CAPABILITY_PREFLIGHT_SCOPE,
          activeToolNames: toolRegistry.getActiveToolNames(),
        }),
      },
      { role: 'user', content: 'x'.repeat(MIN_FEASIBLE_CURRENT_PROMPT_TOKENS * 3) },
    ],
    toolSchemas: tools,
    maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
  }, policy);
  if (!preflight.accepted) {
    throw new RangeError(AGENT_CONTEXT_CAPABILITY_INFEASIBLE);
  }
}
