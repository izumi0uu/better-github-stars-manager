# Pi Source Reference Contract

This document is normative for P1, P3, P4, and context budget/compaction v2. Implementers must review the
listed Pi source before changing the corresponding BGSM provider code. Pi is a
comparison source for protocol boundaries and state-machine behavior; it is not
a dependency or the authority for current provider schemas.

## Authority order

When sources disagree, use this order:

1. BGSM product, privacy, security, browser-runtime, and bounded-resource
   requirements.
2. Current official provider API documentation and OpenAPI/schema definitions.
3. The pinned Pi source below as an implementation comparison.

Never resolve a conflict by copying Pi behavior over a stricter BGSM invariant.

## Pinned source

- Checkout: `/Users/idah/Projects-combined/pi`
- Commit: `6d5ede31c8b8584b422bd0fa2ce10a39b2a0cdce`
- The required files were clean at that commit when this contract was written.

If that checkout moves or is unavailable, inspect the same commit before using
newer Pi behavior. Newer Pi behavior may be considered only when the comparison
record identifies the revision and revalidates it against official provider
documentation.

## Required source map

| Plan | Required Pi source | What must be compared |
| --- | --- | --- |
| P1 Provider Streaming Kernel | `packages/ai/src/types.ts` (`StreamFunction`, `StopReason`, `AssistantMessageEvent`); `packages/ai/src/stream.ts` (`stream`, `complete`, `streamSimple`, `completeSimple`); `packages/ai/src/utils/event-stream.ts` (`EventStream`, `AssistantMessageEventStream`); `packages/ai/src/providers/openai-completions.ts` (`streamOpenAICompletions`) | Lifecycle events, one terminal result, final-response aggregation, abort/error normalization, text and indexed tool-call deltas, usage, and finish reasons. |
| P3 OpenAI Responses Adapter | `packages/ai/src/providers/openai-responses.ts` (`streamOpenAIResponses`); `packages/ai/src/providers/openai-responses-shared.ts` (`convertResponsesMessages`, `convertResponsesTools`, `processResponsesStream`) | Input/output item conversion, `call_id` preservation, event-to-block conversion, tool argument completion, usage, and terminal events. |
| P4 Anthropic Messages Adapter | `packages/ai/src/providers/anthropic.ts` (`iterateAnthropicEvents`, `streamAnthropic`, message conversion around `tool_use` and consecutive `tool_result` blocks) | Content-block ordering, block identity, `input_json_delta`, tool-result grouping, usage/stop normalization, and explicit `message_stop`. |
| Context budget/compaction v2 | `packages/agent/src/harness/compaction/compaction.ts` (`DEFAULT_COMPACTION_SETTINGS`, `calculateContextTokens`, `estimateContextTokens`, `shouldCompact`); `packages/agent/src/harness/compaction/utils.ts` (`TOOL_RESULT_MAX_CHARS`, `serializeConversation`) | Trusted model capacity, provider-usage anchoring, trailing estimation, legal cut points, reserve semantics, recent-history retention, and the boundary between summary serialization and live tool-result admission. |

## Mandatory comparison procedure

Before implementation for each plan:

1. Read every source entry assigned to that plan at the pinned commit.
2. Confirm provider field and event shapes against the current official API
   documentation before writing fixtures or production mappings.
3. Update the comparison record below with the Pi revision, official-doc check
   date, and any implementation divergence discovered during coding.
4. Keep tests derived from official protocol contracts and BGSM invariants, not
   copied Pi SDK fixtures.

A plan is not complete while its comparison record remains `Pending`.

## Baseline comparison record

| Plan | Adopt | Simplify or adapt | Reject | Review status |
| --- | --- | --- | --- | --- |
| P1 | Typed lifecycle events; explicit terminal result; abort propagation; indexed tool-call assembly; final-result aggregation. | Preserve BGSM's existing `ModelResponse`, prepared-request byte accounting, silent OrganizeJob/Compaction aggregation, and browser-native transport. | Pi packages and Node SDKs; generic provider registry; thinking events; unbounded event queues; accepting partial tool arguments. | Implemented and verified 2026-07-14 at Pi `6d5ede31c8b8584b422bd0fa2ce10a39b2a0cdce`, OpenAI OpenAPI `2.3.0`, and OpenAI SDK schema `6.46.0`. |
| P3 | Separate Responses conversion; stable `call_id`; explicit completed/failed/cancelled handling; complete tool-call finalization. | Emit P1 events, omit persistent provider sessions and reasoning content, retain BGSM prepared-request semantics, and allocate contiguous P1 tool indexes independently from provider output indexes. | Pi package/SDK integration; `previous_response_id`; reasoning/thinking persistence; a single mutable `currentItem` assumption. BGSM keys interleaved output by both item identity and output index. | Reviewed 2026-07-15 at Pi `6d5ede31c8b8584b422bd0fa2ce10a39b2a0cdce` against OpenAI OpenAPI `2.3.0` and current Responses streaming/function-calling guides. |
| P4 | Content-block state machine; index-based block lookup; paired `tool_use.id`/`tool_result.tool_use_id`; grouping adjacent tool results; explicit `message_stop`. | Use API-key Messages with browser-native fetch and emit P1 events; include Anthropic's direct-browser access header; ignore thinking blocks instead of presenting or persisting them. | Anthropic SDK; OAuth/Claude Code identity; prompt caching; thinking/signatures; raw SSE payloads in errors or logs; accepting EOF as success. | Reviewed 2026-07-15 at Pi `6d5ede31c8b8584b422bd0fa2ce10a39b2a0cdce` against Anthropic's official TypeScript SDK schema `0.111.0` at `9e46760688a2af71b50581a301b2819d29d28c66`. |
| Context v2 | Provider usage for an already-sent prefix; deterministic estimation for trailing messages; automatic compaction at legal protocol boundaries; model capacity as the starting point. | Use `max(deterministic estimate, provider prefix usage + trailing estimate)`; distinguish provider capacity, optional working cap, soft limit, hard limit, and independent service-worker bytes; compact both before a turn and after a completed tool envelope; use strict no-tool summaries with one corrective retry and a deterministic fallback. | Unknown-model 8192 fallback; a universal 32768 cap; Pi session trees; opaque provider compaction; treating `reserveTokens: 16384` as a live tool-result byte cap; substring truncation of serialized tool JSON. | Implemented and reviewed 2026-07-17 at Pi `6d5ede31c8b8584b422bd0fa2ce10a39b2a0cdce`; integrated release verification remains pending. |

## Prohibited imports and copies

- Do not add a dependency on Pi packages or import files from the Pi checkout.
- Do not copy Pi's Node SDK clients, environment-key lookup, provider registry,
  session/cache machinery, thinking support, or generic event queue.
- Do not copy error formatting that can expose prompts, deltas, tool arguments,
  headers, response bodies, or credentials.
- Do not treat Pi compatibility workarounds as provider requirements unless the
  selected BGSM service needs them and official behavior has been checked.

The intended result is an independent BGSM implementation whose important
state-machine decisions have been compared with Pi and whose wire behavior is
validated against current official schemas.

## P1 implementation comparison

- Review date: `2026-07-14`
- Pi revision: `6d5ede31c8b8584b422bd0fa2ce10a39b2a0cdce`
- Official schema evidence: OpenAI API OpenAPI `2.3.0` for
  `POST /v1/chat/completions`, plus OpenAI's published `openai@6.46.0`
  `src/resources/chat/completions/completions.ts` types
- Referenced official documentation URLs embedded by that schema:
  `https://platform.openai.com/docs/api-reference/chat/streaming` and
  `https://platform.openai.com/docs/guides/streaming-responses`
- Retrieval note: the official developer-docs MCP initially returned HTTP 502
  and direct official-page requests returned HTTP 403. After the MCP was
  reloaded, its OpenAPI tool returned the official `2.3.0` endpoint schema; the
  versioned official SDK types were retained to inspect referenced chunk and
  stream-option component fields that the endpoint-only OpenAPI response did
  not inline.

The official schema confirms that `stream: true` uses server-sent events,
`ChatCompletionChunk.Choice.delta` can carry text, refusal, and indexed function
tool-call fragments, and `finish_reason` is nullable until the terminating
choice chunk. It also confirms that `stream_options.include_usage` adds one
`choices: []` usage chunk immediately before `data: [DONE]`; interrupted streams
may omit that usage chunk.

BGSM adopts Pi's typed lifecycle, explicit terminal result, final aggregation,
abort propagation, and indexed tool-call assembly. BGSM adapts them to a bounded
synchronous observer with no generic event queue, browser-native fetch and SSE
decoding, the existing `ModelResponse`, exact prepared-request bytes, and silent
OrganizeJob/Compaction consumption. BGSM rejects Pi packages, Node SDK runtime code,
thinking events, environment-key lookup, provider registries, raw-body error
formatting, EOF-as-success, successful non-SSE fallback responses, and any
exposure of partial tool arguments as an executable `ModelToolCall`. Successful
Chat Completions calls must use `text/event-stream`, emit a finish reason, and
terminate with `data: [DONE]`; usage-only data is accepted only after the finish
chunk and before `[DONE]`.

P1 implementation verification completed with the provider/SSE/stream,
prepared-request, OrganizeJob, and Compaction target suites; full Vitest
(`101` files, `1377` tests); unit/logic (`85` files, `795` tests); TypeScript
typecheck; production build; and the
basic Puppeteer runtime check. The controlled OrganizeJob extension-host test still
fails its pre-existing queued-Apply timing assertion on both the P1 tree and a
fresh build of base commit `979843210b70fbfdaf34e1bf131a13eb184615b2`; this is
recorded as a baseline host-test gap rather than P1 streaming evidence.

## P3 implementation comparison

- Review date: `2026-07-15`
- Pi revision: `6d5ede31c8b8584b422bd0fa2ce10a39b2a0cdce`
- Official schema evidence: OpenAI API OpenAPI `2.3.0` for
  `POST /v1/responses`, the current Streaming API responses guide, the
  Responses migration guide, and the function-calling streaming guide
- Official documentation URLs:
  `https://developers.openai.com/api/docs/guides/streaming-responses`,
  `https://developers.openai.com/api/docs/guides/migrate-to-responses`, and
  `https://developers.openai.com/api/docs/guides/function-calling#streaming`

The official schema and guides confirm that Responses accepts typed input
items, flat function tool definitions, `function_call` and
`function_call_output` items linked by `call_id`, and typed SSE events such as
`response.output_item.added`, `response.output_text.delta`,
`response.function_call_arguments.delta`, and `response.completed`. BGSM sends
`store: false`, does not send `previous_response_id`, and requires the explicit
`response.completed` event with a completed response status before accepting a
result. Failed, cancelled, incomplete, malformed, or truncated streams fail
closed.

BGSM adopts Pi's separate Responses conversion, stable `call_id`, complete
function argument finalization, and explicit provider terminal handling. BGSM
adapts those decisions to browser-native fetch, the P1 bounded SSE and stream
aggregation contracts, exact single-use prepared bytes, and silent final
aggregation for OrganizeJob. Provider output indexes are not reused as P1 tool
indexes because message and reasoning items can create gaps; function calls get
their own contiguous normalized indexes. Every mutable output event must also
match the active top-level `response_id`; matching item ID and output index alone
is insufficient because opaque identities can collide across responses.

BGSM rejects Pi's OpenAI SDK and package imports, environment and cache/session
machinery, `previous_response_id`, reasoning persistence or presentation, raw
provider error details, and the single mutable `currentItem/currentBlock`
reducer in `processResponsesStream`. That reducer assumes output items arrive
serially; BGSM instead matches every delta and done event against maps keyed by
both provider item ID and output index, so interleaved text, reasoning, and
function-call items cannot corrupt one another.

## P4 implementation comparison

- Review date: `2026-07-15`
- Pi revision: `6d5ede31c8b8584b422bd0fa2ce10a39b2a0cdce`
- Official schema evidence: Anthropic's official TypeScript SDK `0.111.0`,
  generated Messages types and browser client behavior at commit
  `9e46760688a2af71b50581a301b2819d29d28c66`
- Official documentation URLs referenced by that schema:
  `https://platform.claude.com/docs/en/api/messages` and
  `https://platform.claude.com/docs/en/build-with-claude/streaming`
- Retrieval note: direct requests to both official documentation pages were
  redirected to Anthropic's regional-unavailability page. The versioned official
  SDK schema was therefore used for exact wire fields; its generated comments
  link back to those documentation pages.

The official schema confirms top-level `system`, alternating user/assistant
messages, `tool_use` and `tool_result` content blocks linked by
`tool_use_id`, `input_schema` tool definitions, and `auto`, `any`, or named
`tool` choices. Streaming uses `message_start`, indexed
`content_block_start`/`content_block_delta`/`content_block_stop`,
`message_delta`, and `message_stop`; tool arguments arrive as
`input_json_delta.partial_json`. The official browser client sends
`anthropic-version: 2023-06-01` and
`anthropic-dangerous-direct-browser-access: true` in addition to API-key
authentication. Its usage schema states that total input tokens are the sum of
ordinary input, cache-creation input, and cache-read input tokens.

BGSM adopts Pi's indexed content-block state machine, paired tool identities,
adjacent tool-result grouping, cumulative usage updates, and explicit terminal
handling. BGSM adapts them to browser-native
fetch, the P1 bounded SSE and aggregation contracts, exact single-use prepared
bytes, and silent final aggregation for OrganizeJob. Text and tool blocks must
start, receive only matching deltas, and close exactly once; every block must be
closed before `message_stop` can succeed. Thinking and redacted-thinking blocks
are tracked only so their protocol closure can be validated; their content and
signatures are never emitted, persisted, or logged.

Only `end_turn` is accepted as a complete text response and `tool_use` as a
complete tool response. `max_tokens` is incomplete, `pause_turn` requires a
continuation mechanism outside P4, and this adapter never requests custom stop
sequences, so `max_tokens`, `pause_turn`, `stop_sequence`, refusal, and unknown
stop reasons all fail closed.

BGSM rejects Pi's Anthropic SDK integration, Node client construction,
OAuth/Claude Code identity, prompt caching, thinking/signature presentation,
provider-compatibility switches, partial-JSON repair, raw SSE payloads in error
messages, and EOF-as-success. Provider `error` events and malformed, unknown,
out-of-order, duplicate, or truncated blocks fail closed with bounded redacted
errors. P5, not this adapter, owns provider registration, Options wiring, and
Anthropic host permission changes.

## Context budget and compaction v2 comparison

- Review date: `2026-07-17`
- Pi revision: `6d5ede31c8b8584b422bd0fa2ce10a39b2a0cdce`
- Current model-catalog comparison: `@earendil-works/pi-ai@0.80.10`,
  release commit `8dc78834cde4e329284cf505f9e3f99763df5529`.
- Official model evidence:
  `https://developers.openai.com/api/docs/models/gpt-5.5`,
  `https://developers.openai.com/api/docs/models/gpt-5.5-pro`,
  `https://developers.openai.com/api/docs/models/gpt-5.4`,
  `https://developers.openai.com/api/docs/models/gpt-5.4-pro`,
  `https://developers.openai.com/api/docs/models/gpt-5.4-mini`,
  `https://developers.openai.com/api/docs/models/gpt-5.4-nano`,
  `https://developers.openai.com/api/docs/models/gpt-5.3-codex`,
  `https://developers.openai.com/api/docs/models/gpt-5`,
  `https://developers.openai.com/api/docs/models/gpt-5-mini`,
  `https://developers.openai.com/api/docs/models/gpt-4o-mini`, and
  `https://developers.openai.com/api/docs/models/gpt-4.1-mini`
- Router/model evidence: `https://openrouter.ai/api/v1/models` and
  `https://platform.claude.com/docs/en/about-claude/models/overview`

The official GPT-5.4 model page reports a `1,050,000` token context window and
`128,000` maximum output. Its `272K` figure is a pricing threshold for long
prompts, not the context limit. BGSM records those official limits as versioned
capability metadata. An optional working-window setting may reduce, but never
increase, the provider window. Pi `0.80.10` incorrectly records the direct
OpenAI `gpt-5.4` and `gpt-5.5` context windows as `272,000`, while their
OpenRouter entries and OpenAI's model pages record the correct `1,050,000`;
BGSM therefore keeps the official values. A Custom
service reuses an existing capability only on an exact, case-sensitive model ID
match. The user may explicitly override that preset for the Custom endpoint.
Unknown Custom and automatic-router models do not receive an implicit
8192-token capacity; tool-enabled execution still requires an explicit user
declaration.

The current Pi catalog adds the supported GPT-5.5, GPT-5.4 variants, GPT-5.3,
Claude 4.6/4.7, and explicit OpenRouter routes. The same model-page review
records GPT-5 and GPT-5 mini as 400,000/128,000,
GPT-4o mini as 128,000/16,384, and GPT-4.1 mini as 1,047,576/32,768. The
OpenRouter catalog confirms 400,000/128,000 for its explicit GPT-5 routes.
OpenRouter advertises a 1M aggregate route for Claude Sonnet 4 while its current
top-provider entry remains 200,000; BGSM uses the conservative
200,000/64,000 capability because the adapter does not opt into a 1M route.
Pi `0.80.10` records direct Sonnet 4.5 at 1,000,000/64,000 and Haiku 4.5 at
200,000/64,000; BGSM now uses those preset values and adds the current Claude
4.6/4.7 entries. A future catalog increase still requires a new versioned
source revision rather than mutating an existing capability identity.

The current connection probe verifies text and named-tool round trips, not
maximum capacity. `provider-verified` is reserved for a future Provider-specific
metadata resolver and has no v2 producer. Treating a small successful probe or
usage block as capacity verification is explicitly rejected.

BGSM adopts Pi's use of model capacity, automatic threshold checks, provider
usage for an already-sent prefix, deterministic estimation for trailing
messages, and protocol-valid summary cut points. Provider usage can only raise
the measured demand: BGSM takes the maximum of its full deterministic estimate
and the provider-anchored projection, so usage cannot enlarge the configured
working window or bypass preflight.

Pi defaults `reserveTokens` to 16384 and `keepRecentTokens` to 20000. BGSM
adapts that single reserve model into separate concepts: requested output,
safety reserve, compaction reserve, soft limit, hard limit, recent-history
target, dynamic tool-result allowance, and an independent 64 KiB service-worker
memory ceiling. Tool results remain complete JSON envelopes. Source tools
paginate or reduce structured fields, and the harness replaces an oversized
result with a minimal valid error envelope. Pi's `reserveTokens: 16384` is a
token threshold for compaction; BGSM does not reuse `16384` as a byte result
cap. Pi's 2000-character tool-result truncation occurs only while constructing
summary text and is not copied into BGSM's live provider protocol.

BGSM compacts before a turn and after a completed assistant-tool envelope. The
active user message, assistant tool call, and all matching tool results stay
verbatim and protocol-complete. Only older committed history can advance the
checkpoint; raw client-owned history is unchanged. Summaries receive no tools,
treat history as untrusted, and cannot authorize writes or establish current
repository facts. One malformed or length-limited summary gets one corrective
retry. Provider failure or a second invalid summary uses a deterministic,
UTF-8-bounded fallback with six fixed headings.

Content-free diagnostics expose only numeric capacity/usage/budget values and
bounded categories for trigger, retry, fallback, and terminal outcome. Prompts,
repository names, notes, code, tool payloads, credentials, tokens, headers, and
raw Provider errors are excluded and covered by canary tests. Exact context
failure reasons cross the Agent Port so the UI can retry, open AI settings, or
start a new conversation without exposing protocol terminology.

Verification is mapped to `bgsm-agent-context-policy`,
`agent-tool-context-budget`, `bgsm-agent-compaction-execution`, Provider usage
and overflow suites, background Port contracts, Options preferences, and
AgentPanel recovery tests. Repository code search remains release-gated until
the integrated unit, integration, regression, runtime, build, package, and
manual unpacked-Chrome matrix is fresh. This is an explicit release stop
condition; it is not yet clean-tree RC evidence.
