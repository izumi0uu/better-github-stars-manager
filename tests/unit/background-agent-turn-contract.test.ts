import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { backgroundSource } from '../helpers/background-case-block';

const turnPortSource = readFileSync(
  new URL('../../src/background/bgsm-agent-turn-port.ts', import.meta.url),
  'utf8',
);
const deliverySource = `${backgroundSource}\n${turnPortSource}`;

describe('background agent turn contract', () => {
  it('routes Cubby through the agent loop and configured provider', () => {

    assert.doesNotMatch(backgroundSource, /type: ["']startBgsmAgentTurn["']/);
    assert.match(backgroundSource, /chrome\.runtime\.onConnect\.addListener/);
    assert.match(backgroundSource, /port\.name !== ["']bgsm-agent["']/);
    assert.match(deliverySource, /bgsmAgentTurnEvent/);
    assert.match(deliverySource, /bgsmAgentTurnResult/);
    assert.match(backgroundSource, /createProvider: createRegisteredAgentProvider/);
    assert.match(backgroundSource, /agentProviderGate\.createRuntimeProvider\(\)/);
    assert.match(backgroundSource, /agentProviderGate\.prepareRuntimeProvider\(\)/);
    assert.match(backgroundSource, /providerFingerprint: preparedRuntimeProvider\.fingerprint/);
    assert.match(backgroundSource, /runAgentLoop\(/);
    assert.match(backgroundSource, /const executionLedger = new AgentExecutionLedger\(\)/);
    assert.match(backgroundSource, /contextPolicy: profile,[\s\S]*?executionLedger,/);
    assert.doesNotMatch(backgroundSource, /idbTagStore\.listTagMeta\(\)[\s\S]*?buildBgsmAgentSystemPrompt/);
    assert.match(backgroundSource, /resolveBgsmAgentConversation\(input/);
    assert.match(backgroundSource, /const repositoryScope = conversation\.repositoryIds/);
    assert.doesNotMatch(backgroundSource, /loadLiveBgsmAgentRepositoryScope/);
    assert.match(backgroundSource, /createBgsmAgentTools\(\{[\s\S]*?repositoryScope,/);
    assert.match(backgroundSource, /const scopeFingerprint = conversation\.binding\.scopeFingerprint/);
    assert.match(backgroundSource, /createBgsmAgentTools\(\{[\s\S]*?scopeFingerprint,/);
    assert.match(backgroundSource, /scopeLabel,/);
    assert.match(backgroundSource, /repositoryCodeRefAuthorityFor\(/);
    assert.match(backgroundSource, /repositoryCodeRefAuthority,/);
    assert.match(backgroundSource, /hasRepositoryCodeHistory = hasSuccessfulRepositoryCodeToolHistory\(input\.history\)/);
    assert.match(backgroundSource, /repositoryCodeAccess = promptIntent\.capabilities\.repositoryCodeSearch[\s\S]*?\|\| hasRepositoryCodeHistory/);
    assert.match(backgroundSource, /repositoryCodeReadOnly = promptIntent\.capabilities\.repositoryCodeSearch[\s\S]*?\|\| hasRepositoryCodeHistory/);
    assert.doesNotMatch(backgroundSource, /repositoryCodeReference/);
    assert.doesNotMatch(backgroundSource, /promptIntent\.useTools|manualTagAdditions/);
    assert.doesNotMatch(backgroundSource, /interactionScope|interactionParent|scope_selector/);
    assert.match(backgroundSource, /enableRepositoryCodeSearch: repositoryCodeAccess/);
    assert.match(backgroundSource, /enableRepositoryNotes: promptIntent\.capabilities\.repositoryNotes/);
    assert.match(backgroundSource, /enableOrganizeLibraryHandoff: !repositoryCodeReadOnly/);
    assert.match(backgroundSource, /requestOrganizeLibraryHandoff: async \(action\) =>/);
    assert.match(backgroundSource, /status: 'blocked_by_existing_job'/);
    assert.match(backgroundSource, /organizeLibraryHandoffRequested \?\?= action/);
    assert.match(backgroundSource, /tool\.risk !== 'write'/);
    assert.match(
      backgroundSource,
      /!repositoryCodeReadOnly && !organizeApplyActive && tool\.name === 'assign_repo_tags'/,
    );
    assert.match(backgroundSource, /buildBgsmAgentSystemPrompt\(\{ repositoryCodeReadOnly \}\)/);
    assert.match(backgroundSource, /systemPrompt,/);
    assert.match(backgroundSource, /prepareBgsmAgentTurn\(/);
    assert.match(backgroundSource, /emit: options\.emit/);

    assert.match(backgroundSource, /buildBgsmAgentTerminalPayload\(/);
    assert.match(backgroundSource, /organizeLibraryHandoffRequested && result\.reason !== 'aborted'/);
    assert.match(backgroundSource, /action: organizeLibraryHandoffRequested/);
    assert.match(backgroundSource, /instruction: prompt/);
    assert.match(backgroundSource, /runTurn: \(input, options\) => runBgsmAgentTurn\(input, options\)/);
    assert.doesNotMatch(backgroundSource, /runTurn: \(input, options\) => run\(/);
    assert.match(turnPortSource, /function deliveryEvent[\s\S]*?turnAttemptId: input\.turnAttemptId,[\s\S]*?sessionId: input\.sessionId,[\s\S]*?baseRevision: input\.baseRevision/);
  });

  it('uses client-owned session history and returns only new turn messages', () => {
    assert.match(backgroundSource, /const \{ prompt, sessionId, baseRevision, turnAttemptId \} = input;/);
    assert.match(backgroundSource, /buildBgsmAgentTerminalPayload\(/);
    assert.match(deliverySource, /baseRevision: input\.baseRevision/);
    assert.match(deliverySource, /const parsed = parseStartMessage\(rawMessage\)/);
    assert.match(deliverySource, /validateBgsmAgentSessionHistory\(history\)/);
    assert.match(deliverySource, /verifyBgsmAgentCheckpoint\(history, value\.checkpoint\)/);
    assert.match(deliverySource, /type: ["']bgsmAgentTurnError["'][\s\S]*?sessionId: input\.sessionId,[\s\S]*?baseRevision: input\.baseRevision/);
    assert.doesNotMatch(backgroundSource, /const sessionId = `bgsm_\$\{Date\.now\(\)\}`/);
  });

  it('does not expose the legacy proposal review message flow', () => {
    assert.doesNotMatch(backgroundSource, /generateAgentTagSuggestions/);
    assert.doesNotMatch(backgroundSource, /generateAgentTagCleanup/);
    assert.doesNotMatch(backgroundSource, /listAgentProposals/);
    assert.doesNotMatch(backgroundSource, /applyAgentProposals/);
    assert.doesNotMatch(backgroundSource, /runBgsmSuggestionTool/);
  });

  it('allows agent write tools and broadcasts after tool-driven changes', () => {
    assert.match(backgroundSource, /permissions: authorization\.permissions/);
    assert.match(backgroundSource, /assignManualTags: agentManualTagWriter/);
    assert.match(backgroundSource, /createQueuedAgentManualTagWriter/);
    assert.match(
      backgroundSource,
      /runSerialized: \(operation, runOptions\) => jobQueue\.run\(operation, runOptions\)/,
    );
    assert.match(
      backgroundSource,
      /isBlocked: async \(\) => organizeApplyBlocksAgentWrites\(await getActiveOrganizeJob\(\)\)/,
    );
    assert.match(backgroundSource, /function organizeApplyBlocksAgentWrites[\s\S]*?apply_sealed[\s\S]*?applying[\s\S]*?paused/);
    assert.match(backgroundSource, /wrapWriteTrackingTool/);
    assert.match(
      backgroundSource,
      /message\.type === "applyBgsmOrganizeSelection"[\s\S]*?jobQueue\.run\(async \(\) => \{[\s\S]*?sealOrganizeApply[\s\S]*?\}\);[\s\S]*?pumpOrganizeApply/,
    );
    assert.match(backgroundSource, /if \(changed\) broadcastDataChanged\(\)/);
  });

  it('prepares compaction before the loop and transports checkpoints without partial deltas', () => {
    assert.match(backgroundSource, /await prepareBgsmAgentTurn\(/);
    assert.match(backgroundSource, /prepared\.kind === ["']context_limit["']/);
    assert.match(backgroundSource, /reason: ["']context_limit["'][\s\S]*?newMessages: \[\]/);
    assert.match(backgroundSource, /maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS/);
    assert.match(backgroundSource, /contextPolicy: profile/);
    assert.match(backgroundSource, /onContextOverflow: continueAfterContextPressure/);
    assert.match(backgroundSource, /contextFailureReason === ['"]provider_context_overflow['"]/);
    assert.match(backgroundSource, /contextFailureReason === ['"]provider_context_overflow_repeated['"]/);
    assert.match(backgroundSource, /invalidateAgentProviderCapability\(preparedRuntimeProvider\.fingerprint\)/);
    assert.match(backgroundSource, /buildBgsmAgentTerminalPayload\([\s\S]*?checkpointToCommit,[\s\S]*?candidateActiveProjection/);
    assert.match(backgroundSource, /const initialRawMessages = \[prepared\.messages\.at\(-1\)!\]/);
    assert.match(backgroundSource, /messages: prepared\.messages,[\s\S]*?rawMessages: initialRawMessages/);
    assert.match(backgroundSource, /rawMessages: continuation\.rawMessages/);
    assert.match(backgroundSource, /onToolEnvelopeSettled: continueAfterContextPressure/);
    assert.match(backgroundSource, /currentActiveProjection: activeTurnProjection/);
    assert.match(backgroundSource, /activeTurnProjection = compacted\.activeProjection/);
    assert.match(backgroundSource, /candidateActiveProjection = compacted\.activeProjection/);
  });

  it('uses the liveness-normalized reason for both status and terminal message selection', () => {
    assert.match(backgroundSource, /createAgentTurnLiveness\(\{[\s\S]*?onTimeout: \(reason\) => controller\.abort\(reason\)/);
    assert.match(backgroundSource, /reason: timeoutReason \? ['"]provider_error['"] : ['"]aborted['"]/);
    assert.match(
      backgroundSource,
      /const effectiveReason = organizeLibraryHandoff \? 'final_answer' : result\.reason/,
    );
    assert.match(backgroundSource, /reason: effectiveReason,[\s\S]*?buildBgsmAgentTerminalPayload\(\s*\{ \.\.\.result, reason: effectiveReason \}/);
  });

  it('keeps ordinary turns independent from removed product interaction branches', () => {
    assert.doesNotMatch(backgroundSource, /suspendAgentIdle|resumeAgentIdle|interactionCompletion/);
    assert.match(backgroundSource, /let result = await runAgentLoop\(/);
    assert.match(turnPortSource, /\.then\(\s*\(result\) => finishAttempt\(attempt, result\)/);
  });
});

const compactionSource = readFileSync(
  new URL('../../src/bgsm-agent/compaction.ts', import.meta.url),
  'utf8',
);

describe('background agent compaction status events', () => {
  it('emits context compaction start/end from prepare', () => {
    assert.match(compactionSource, /context_compaction_start/);
    assert.match(compactionSource, /context_compaction_end/);
    assert.match(backgroundSource, /emit: options\.emit/);
  });
});
