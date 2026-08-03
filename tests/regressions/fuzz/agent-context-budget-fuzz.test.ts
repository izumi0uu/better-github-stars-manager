import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  MIN_TOOL_RESULT_ENVELOPE_BYTES,
  preflightContextRequest,
  resolveContextBudgetPolicy,
  runAgentLoop,
  type AgentTool,
  type ModelGenerateInput,
  type ModelResponse,
  type ToolResultAllowance,
} from '@/agent-harness';
import {
  createRng,
  fuzzCases,
  fuzzFailure,
} from '../../helpers/seeded-fuzz';

const FILE = 'tests/regressions/fuzz/agent-context-budget-fuzz.test.ts';
const PREFIX = 'AGENT_CONTEXT_BUDGET_FUZZ';
const SUITE = 'agent context budget fuzz';
const CASES = fuzzCases(PREFIX, '20260717-agent-context-budget', 100);
const encoder = new TextEncoder();
const characters = ['x', '界', '😀', 'é'] as const;

describe('agent context budget seeded fuzz', () => {
  for (const caseIndex of CASES.cases) {
    it(`keeps admitted tool result ${caseIndex} within the next request budget`, async () => {
      const rng = createRng(CASES.seed, caseIndex);
      const contextWindow = rng.pick([4_096, 8_192, 16_384, 32_768, 131_072]);
      const requestedOutputTokens = rng.pick([128, 256, 512, 1_024]);
      const memoryResultCeilingBytes = rng.pick([256, 700, 4_096, 16_384, 65_536]);
      const policy = resolveContextBudgetPolicy({
        capability: {
          schemaVersion: 1,
          contextWindow,
          maxOutputTokens: Math.min(8_192, contextWindow),
          source: 'user-declared',
          sourceRevision: 'seeded-fuzz',
          capabilityRevision: `seeded-fuzz:${caseIndex}`,
        },
        requestedOutputTokens,
        safetyReserveTokens: Math.min(1_024, Math.floor(contextWindow / 4)),
        memoryResultCeilingBytes,
      });
      const character = rng.pick(characters);
      const prompt = character.repeat(rng.int(1, 400));
      const description = character.repeat(rng.int(1, 240));
      const allowances: ToolResultAllowance[] = [];
      const requests: ModelGenerateInput[] = [];
      const requestedResultFactor = rng.int(1, 160) / 100;
      const tool: AgentTool = {
        name: 'read_seeded_page',
        description,
        risk: 'read',
        parameters: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            query: { type: 'string', description },
          },
          required: ['page'],
          additionalProperties: false,
        },
        async execute(_args, context) {
          assert.ok(context.resultAllowance);
          allowances.push(context.resultAllowance);
          const targetBytes = Math.max(
            MIN_TOOL_RESULT_ENVELOPE_BYTES,
            Math.floor(context.resultAllowance.maxSerializedBytes * requestedResultFactor),
          );
          const characterBytes = encoder.encode(character).byteLength;
          return {
            payload: character.repeat(Math.ceil(targetBytes / characterBytes)),
          };
        },
      };
      let providerCall = 0;

      const result = await runAgentLoop({
        sessionId: `context-budget-fuzz-${caseIndex}`,
        messages: [{
          id: `user-${caseIndex}`,
          role: 'user',
          content: prompt,
          createdAt: 1,
        }],
        tools: [tool],
        contextPolicy: policy,
        maxOutputTokens: requestedOutputTokens,
        idFactory: sequentialIdFactory(`case-${caseIndex}`),
        provider: {
          async generate(input): Promise<ModelResponse> {
            requests.push(input);
            providerCall += 1;
            return providerCall === 1
              ? {
                  toolCalls: [{
                    id: `call-${caseIndex}`,
                    name: tool.name,
                    arguments: { page: 1, query: prompt },
                  }],
                }
              : { content: 'done' };
          },
        },
      });
      const trace = {
        caseIndex,
        contextWindow,
        requestedOutputTokens,
        memoryResultCeilingBytes,
        characterBytes: encoder.encode(character).byteLength,
        promptBytes: encoder.encode(prompt).byteLength,
        schemaBytes: encoder.encode(JSON.stringify(tool.parameters)).byteLength,
        requestedResultFactor,
        resultReason: result.reason,
      };

      assert.equal(
        result.reason,
        'final_answer',
        fuzzFailure({
          suite: SUITE,
          prefix: PREFIX,
          seed: CASES.seed,
          caseIndex,
          file: FILE,
          invariant: 'an admitted tool result reaches the next provider step',
          trace,
        }),
      );
      assert.equal(allowances.length, 1);
      assert.equal(requests.length, 2);
      const toolMessage = result.messages.find((message) => message.role === 'tool');
      assert.ok(toolMessage);
      assert.doesNotThrow(() => JSON.parse(toolMessage.content));
      const resultBytes = encoder.encode(toolMessage.content).byteLength;
      assert.ok(
        resultBytes <= allowances[0].maxSerializedBytes,
        fuzzFailure({
          suite: SUITE,
          prefix: PREFIX,
          seed: CASES.seed,
          caseIndex,
          file: FILE,
          invariant: 'finalized result stays within its UTF-8 byte allowance',
          expected: allowances[0].maxSerializedBytes,
          actual: resultBytes,
          trace,
        }),
      );
      const nextRequest = requests[1];
      const preflight = preflightContextRequest({
        messages: nextRequest.messages,
        toolSchemas: nextRequest.tools,
        maxOutputTokens: requestedOutputTokens,
      }, policy);
      assert.ok(
        preflight.accepted,
        fuzzFailure({
          suite: SUITE,
          prefix: PREFIX,
          seed: CASES.seed,
          caseIndex,
          file: FILE,
          invariant: 'admission implies successful next-request preflight',
          expected: policy.hardLimit,
          actual: preflight.inputTokens,
          trace,
        }),
      );
    });
  }
});

function sequentialIdFactory(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
