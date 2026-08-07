# Cubby Implementation Review and Production-Safety Plan

## Document status

- **Review verdict:** `REMEDIATED` for the code-level findings tracked in the 2026-07-14 repair pass
- **Launch status:** the Phase 3 harness-extension seam is implemented and independently child-verified; parent Phases 4–8, clean-tree Release Candidate packaging, and credential-dependent manual Chrome checks remain pending
- **Reviewed branch:** `feat/agent-tag-assistant`
- **Original review date:** 2026-07-10
- **Remediation date:** 2026-07-14
- **Context v2 integration date:** 2026-07-17
- **Conversation/workflow ownership verification date:** 2026-08-06
- **Harness-extension-seam full-child verification date:** 2026-08-07
- **Audience:** maintainers implementing, reviewing, and testing Cubby
- **Scope:** the Cubby runtime, provider adapters, background orchestration, Port protocols, release evidence, and packaged-extension runtime

This document preserves the original findings and remediation plan as review history. The 2026-07-14 closure record does not by itself prove context v2 release readiness; executable source, current tests, and the fresh verification matrix remain the enforced runtime contract.

The earlier [MVP Agent Harness Blueprint](./bgsm-agent-tag-assistant-plan.md) remains useful as design history, but its proposal-only implementation checkpoint does not describe the current branch. Where the two documents conflict, this review describes the current code and the required merge gates; a later accepted product decision should replace both with one canonical specification.

The conversation/workflow ownership product contract is captured in `.trellis/tasks/08-06-conversation-workflow-ownership/`, with executable long-term boundaries in `.trellis/spec/extension/runtime-boundaries.md`. This document owns implementation and safety findings; executable source and regression tests own the enforced runtime behavior.

## Phase 3 harness-extension seam — 2026-08-07

The Phase 3 child in `.trellis/tasks/08-07-harness-extension-seam/` is implemented and independently child-verified. This is not a release-ready declaration: parent Phases 4–8 and clean-tree release gates remain pending or out of scope for this child.

### Current implementation and source-of-truth boundaries

```text
Provider/tool protocol
  -> generic Agent harness admission host
  -> BGSM result externalizer + coverage state machine
  -> full-envelope durable checkpoint through AgentAttemptCoordinator
  -> canonical source candidate or internal Provider projection
  -> BGSM episode driver resumes the exact durable cursor
  -> complete coverage receipt + canonical commit transaction
```

- **Generic admission host:** `src/agent-harness` owns Provider/tool ordering and a provider-neutral result-admission contract. The host may transform an ordinary `ToolResult`, attach bounded `opaqueReferences`, replace the authoritative `requiredBeforeFinal` set, and checkpoint a complete envelope before publication. The harness does not interpret artifact identity, cursors, storage, cleanup, or BGSM error policy; the independent check found zero harness references to the product artifact literals/imports and obsolete writer/disposer contracts.
- **BGSM application layer:** the BGSM externalizer alone serializes an oversized successful read, creates the deterministic local cache artifact and bounded pointer result, supplies the artifact-reader instruction, and disposes an unadmitted cache record. Its one-shot evidence handoff keeps verified artifact, manifest, byte, cursor, and touched-chunk evidence out of model-visible results. The pure coverage state machine decides exact-cursor transitions, while the episode driver owns trusted continuation prompts, exclusive reader capability, adaptive projection reduction, and cross-episode continuation.
- **Storage and transaction authority:** `AgentAttemptCoordinator` and the storage transactions are the only durable coverage authority. A complete assistant/tool envelope, its coverage proposals, directive set, bounded continuation projection, canonical source candidate, and durable re-prompt flag are revalidated against the exact running attempt/lease and committed atomically before any message or presentation event is published. The unreleased Dexie v4 attempt row remains the coverage/checkpoint source of truth.
- **Canonical transcript versus Provider projection:** the initial source envelope that creates an obligation remains a canonical candidate. Internal artifact-reader envelopes and provisional assistant prose exist only in the bounded Provider projection; they never become canonical raw transcript rows. Once every directive clears, only the accepted final assistant response joins the canonical source envelope at commit.
- **Exact coverage:** the first exhaustive page omits a cursor; every later page must use the exact durable `expectedCursor`. Offset and literal-search reads remain useful locating operations but record zero advancing bytes and cannot change the progress token or complete coverage. Completion requires the issued chain to reach `nextCursor === null` with the exact byte count and immutable artifact/manifest evidence. Continuation adapts to request, context, memory, page, cancellation, transport, and storage limits without adding a total-page cap beyond the existing logical storage ceiling.
- **Re-prompt and stall:** premature final prose, unrelated calls, invalid calls, or an unchanged directive set publish no provisional assistant text. The first non-progress response consumes one durably fenced, constrained exact-cursor re-prompt; the next settles typed `agent_artifact_coverage_stalled` and marks pending coverage incomplete.
- **Receipts, ownership, cleanup, and recovery:** terminal commit rejects pending, incomplete, or tampered coverage; attaches the immutable receipt to the exact canonical source tool-message row; promotes only a newly owned cache artifact; and preserves the existing owner for a later inspection of a canonical artifact. Failure cleanup removes only attempt-owned, unbound cache and never a pre-existing canonical artifact. Committed receipt replay performs no Provider, tool, or coverage work. Worker replacement may resume only a storage-validated `statically_read_only` attempt from its exact durable checkpoint/cursor; write-capable, unknown, or damaged recovery fails closed without execution.

### Independent repair and full child evidence

The independent check repaired the cross-slice TypeScript narrowing/import drift; cumulative sibling tool-result budget accounting; orderly aborted-envelope settlement; Dexie transactions that awaited Web Crypto without `Dexie.waitFor`; final coverage-fence ordering; targeted-search evidence so it reports `pageBytes = 0` and `nextCursor = null`; the packaged fixture so it exceeds the adaptive 64 KiB result-memory ceiling and performs a real bounded projection reduction; the trace exporter so it follows and validates every exact issued cursor through the final `null`; and exact Scenario Lab closure/receipt/coverage checks without casts that hid mismatches.

Observed verification evidence:

- `pnpm typecheck`: passed.
- Focused Vitest command: 26 files and 464 tests passed.
- `pnpm test:runtime:agent-scenarios --scenario cubby-artifact-continuation-coverage`: passed with 1 retained root, 284 events after diagnostics reload/export, and zero network requests; its internal build transformed 2,397 modules and emitted identity `09216717-994b12-7d63ad`.
- `pnpm test:integration`: 1 file and 17 tests passed.
- `pnpm test:logic`: 137 files and 1,734 tests passed.
- `pnpm test:regressions`: 15 files and 673 tests passed.
- `pnpm build`: passed after transforming 2,397 modules and emitted identity `09216717-9281f5-05d392`; the existing large-chunk advisories remained visible.
- `pnpm test:runtime:agent-scenarios`: all 9 packaged Scenario Lab fixtures passed with 9 retained roots, 413 events, and zero network requests; its internal build emitted identity `09216717-9281f5-a63f50`.

Still pending in this record: parent Phases 4–8, clean-tree release packaging, and manual credential-dependent checks. None is implied green by the completed Phase 3 child gate.

## Product autonomy decision — 2026-08-03

Repository tags are treated as low-impact local annotations. Regular Cubby conversations may directly remove visible tags from repositories and delete tag names globally; the earlier recommendation that every removal require a proposal and separate Apply confirmation is retained below as review history but no longer describes the accepted product contract.

The direct path is still constrained by application code:

- `remove_repo_tags` and `delete_tags_everywhere` are available on regular turns rather than enabled by keyword or intent matching;
- every repository/tag removal needs same-turn local assignment evidence, and every global tag deletion needs same-turn tag-list evidence;
- repository-code conversations remain host-enforced read-only, explicit no-write requests are interpreted by the main model, and an active Organize Apply holds the shared write lock;
- repository removals and global deletions execute as separate atomic IndexedDB batches and preserve Gist dirty-outbox semantics;
- canonical write effects are recorded in the execution ledger so retries execute only effects that are not already committed;
- the Cubby UI reports the tool activity and final mutation count without synthesizing a keyword-driven confirmation or unavailable card.

Global deletion writes `TagMeta.excluded` tombstones and therefore remains semantically different from removing a visible tag on selected repositories. The model must not substitute one operation for the other or broaden the requested repositories or tag names.

## Remediation closure — 2026-07-14

The repair pass closed the eight implementation findings selected from the comprehensive review:

1. Release packaging now fingerprints the exact production package input, binds package and Phase 5 evidence to one clean commit, and refuses to finalize dirty-source evidence.
2. Write authorization is derived once from the current prompt as explicit capabilities; model-facing removal and global deletion remain denied.
3. OpenAI-compatible, OpenAI Responses, and Anthropic HTTP failures expose bounded product copy and status only, never provider-authored response text.
4. Compaction distinguishes caller cancellation from context exhaustion and propagates provider failures instead of relabeling them as context limits.
5. Controller, scheduler, and interaction state now has explicit release paths plus bounded terminal retention; continuation analysis state remains available until release or bounded eviction.
6. Tool completion events carry authoritative `writeOutcome` risk states so the UI cannot present unknown writes as ordinary completion.
7. Agent Port messages are strictly validated by direction, event shape, delivery identity, result reason, and cross-field invariants.
8. The packaged MV3 extension-host scenario intercepts real `/v1/responses` SSE traffic and proves an `assistant_text_delta` reaches the Agent Port before the final result.

Verification evidence from the repair pass:

- `pnpm typecheck`: passed.
- `pnpm test:vitest`: passed 106 files and 1,469 tests.
- `pnpm test:runtime`: passed.
- `pnpm test:smoke`: passed all seven browser scenarios.
- `pnpm test:runtime:organize-job-host`: passed five packaged-extension scenarios with intercepted Responses requests and zero live traffic.
- `pnpm test:runtime:organize-job-recovery`: passed the sixth packaged-extension scenario for alarm-driven recovery after MV3 worker termination.
- `pnpm build`: passed; the existing Mermaid chunk-size warning remains non-blocking.
- `pnpm package:extension`: passed and recorded the current dirty worktree as not release-ready.
- `pnpm verify:agent-phase5`: intentionally refused this uncommitted worktree at its clean-source precondition. Run it after commit to generate final release-ready evidence.

## 1. Executive summary

The branch contains a useful Agent prototype:

- a small provider-neutral loop under `src/agent-harness`;
- BGSM-specific instructions and typed tools under `src/bgsm-agent`;
- background-owned IndexedDB access;
- a Chrome Port for lifecycle events and cancellation;
- provider settings for OpenAI, OpenRouter, and a custom OpenAI-compatible endpoint;
- an in-product Agent panel built on the existing ShadowRoot and design system.

The implementation is not merge-ready as a write-capable feature. The primary problem is not that the UI uses chat or that the branch removed the old proposal store. The problem is that the current control plane grants model-facing write tools unconditional permission and then relies on prompt text to keep destructive actions safe. Several additional defects make the behavior unreliable:

1. one saved API key can be silently reused with a different provider or custom origin;
2. `assign_repo_tags` can promote existing auto tags into the manual layer;
3. excluded tags can be resurrected without a user-owned re-add;
4. provider timeouts stop at response headers and malformed success responses fail open;
5. the Agent cannot reliably enumerate a large star library for its primary Auto Assign task;
6. the ShadowRoot capture listener prevents the composer textarea from receiving Enter;
7. model-facing tool output can include private notes, while current privacy documents say data is shared only with GitHub;
8. the full test suite has an Agent-related failure in the shared Chrome runtime mock.

The smallest safe first release is not a full autonomous assistant. It is a bounded task workbench with:

- read-only inspection;
- an explicitly invoked, scope-limited additive auto-tag operation;
- runtime-enforced limits and excluded-tag policy;
- proposal and confirmation for removal or global deletion;
- deterministic mutation receipts;
- honest UI state and privacy disclosure.

## 2. Product boundary and recommended autonomy

### 2.1 Model responsibility

The model may:

- interpret the user task;
- choose among tools that the harness makes visible for the selected capability;
- propose tag names based on repository metadata and the existing taxonomy;
- summarize observations and deterministic mutation receipts;
- explain skipped repositories and uncertainty.

The model must not:

- decide its own permission level;
- bypass tool validation;
- treat GitHub descriptions, topics, notes, or connector data as instructions;
- approve destructive changes;
- infer that a mutation succeeded from prose;
- silently broaden the user-selected repository scope;
- expose private notes unless the user has enabled a dedicated capability.

### 2.2 Harness responsibility

Application code must:

- assemble trusted instructions and bounded context;
- choose the visible capability-specific tool set;
- validate every input and output locally;
- enforce repository scope, tag budgets, exclusion policy, and write count;
- require approval for destructive actions;
- execute writes through the background-owned store;
- record a deterministic receipt for every attempted mutation;
- emit terminal states that distinguish success, partial success, denial, abort, timeout, and failure;
- keep provider credentials bound to the provider/origin for which they were saved.

### 2.3 Recommended capability matrix

| Capability | User entry point | Model-visible tools | Write policy | Required result |
| --- | --- | --- | --- | --- |
| Inspect | Free-form question or Inspect task | Read-only tools | Never writes | Answer plus source counts |
| Auto-tag scoped repositories | Explicit Auto Tags action with visible scope | Read tools plus additive assignment | Direct write is allowed only inside the selected scope and hard budgets | Mutation receipt plus skipped repos |
| Clean up tags | Explicit cleanup task | Read tools plus proposal creation | Removal requires review and confirmation | Proposed actions with impact counts |
| Delete tag everywhere | Explicit destructive action | Preview only before confirmation | Commit must be user-owned; never a model-only decision | Precondition-checked receipt and recovery information |

The main model selects optional read tools from conversation context instead of a current-prompt regular expression. Tool selection does not grant write authority: repository scope, current-turn local evidence, write budgets, and repository-code read-only mode remain host-enforced.

## 3. Current implementation map

```text
Toolbar Auto Tags / free-form prompt
  -> AgentPanel
  -> useBgsmAgent
  -> chrome.runtime Port: bgsm-agent
  -> background global serialized runner
  -> runBgsmAgentTurn
      -> configured OpenAI-compatible provider
      -> fixed system instructions + current prompt
      -> at most 8 model steps
      -> 3 read tools + 3 write tools
      -> unconditional permission evaluator
      -> IndexedDB tag mutations
  -> lifecycle and complete-message events
  -> AgentPanel status, transcript, and tool cards
```

### 3.1 Runtime facts

- The content-side Hook owns transient presentation state plus a bounded, paginated transcript view. Canonical raw history, revision, binding, checkpoint, active projections, and the current bounded launch/retry envelope remain in background-owned IndexedDB. Admission stores that envelope atomically before Provider work, so a replacement MV3 worker can recover the exact prompt without relying on page memory or `chrome.storage.local`; commit, terminalization, and conversation deletion remove it transactionally. A turn crosses the Agent Port with only its attempt identity, `sessionId`, `baseRevision`, prompt, and an optional first-turn scope candidate; after acquiring the durable lease, the service worker loads the canonical history internally. A retained completed or cancelled Organize result is separate workflow evidence, not conversation history, and follows the bounded retention rules in section 10.4.
- The background binds the conversation to Provider fingerprint, repository scope, capability policy, and current authorization before calling the harness.
- Provider adapters emit incremental text deltas plus strict terminal results. Tool calls become executable only after their complete arguments and protocol envelope validate.
- Optional notes and repository-code tools are visible to the main model on regular turns so follow-up requests can be resolved from conversation context. Their descriptions and system instructions restrict use to the current user request.
- Historical or compacted text never establishes tag-write authority. Repository scope, current-turn local evidence, and mutation budgets remain host-enforced, and a successful repository-code read makes the conversation read-only.
- Automatic compaction projects older committed history into a no-tool checkpoint summary while preserving durably stored raw history and the active user/tool suffix.
- Flat conversations survive refresh and can be created, switched, and deleted. Deletion blocks while a linked Organize workflow is nonterminal, removes conversation-owned history/recovery/artifacts after settlement, and does not erase the latest terminal Organize evidence. Branching session trees and autonomous background goals remain deferred.

### 3.2 Current model-facing tools

| Tool | Current risk | Current behavior |
| --- | --- | --- |
| `list_tags` | Read | Lists non-excluded visible tag names and repository counts |
| `get_star` | Read | Resolves an exact, case-insensitive `owner/name` inside the frozen scope without querying outside it |
| `search_stars` | Read | Searches structured normalized terms with `auto`/`all`/`any` matching, ranking, scope diagnostics, and bounded cursor pagination |
| `inspect_tag` | Read | Returns scoped live repositories using one visible tag; private notes are excluded |
| `list_repository_files` | Conditional read | Lists one public repository directory at an immutable commit ref |
| `search_repository_code` | Conditional read | Searches the bounded GitHub code index and returns verified, pinned snippets; at most one search runs per turn |
| `read_repository_file` | Conditional read | Reads at most 200 text lines using a trusted commit ref returned by list/search |
| `read_repository_notes` | Conditional private read | Returns bounded private notes only when the current prompt explicitly requests them |
| `read_agent_artifact` | Read | Reads a session-owned oversized tool result through an opaque, bounded cursor |
| `assign_repo_tags` | Write | Adds manual tags after the main model selects the action and same-turn local repository evidence exists |
| `remove_repo_tags` | Write | Atomically removes requested visible repository/tag pairs after same-turn assignment evidence |
| `delete_tags_everywhere` | Write | Atomically removes requested tag names from all repositories and writes exclusion tombstones after same-turn tag evidence |

All three tag mutation tools are present on regular turns. The main model interprets whether the conversation requests a mutation; runtime authorization independently enforces repository scope, same-turn evidence, write budgets, and code-read-only mode. Oversized read results are persisted as a short-lived cache artifact and exposed through `read_agent_artifact`; a successful session commit promotes the referenced artifact to canonical storage. After any repository-code tool runs, that conversation stays read-only; tag changes require a new conversation.

The registry is defined in `src/bgsm-agent/tools.ts` and `src/bgsm-agent/repository-code-search-tool.ts`.

## 4. Reusable strengths

### 4.1 Correct high-level ownership

The background service worker remains the owner of IndexedDB writes. The content-script UI does not open a second database at the wrong extension origin. This is the right place to preserve storage invariants and serialize commits.

### 4.2 Small harness boundary

`src/agent-harness` separates:

- provider adaptation;
- message conversion;
- tool definitions and local validation;
- permission evaluation;
- loop events and stop reasons.

This is enough structure for the product without importing a coding-agent framework into the extension bundle.

### 4.3 Domain tools reuse the existing store

Writes pass through `idbTagStore`, so they participate in existing normalization and Gist dirty tracking. The fix should preserve this boundary rather than introducing a second Agent-only persistence path.

### 4.4 Provider configuration is centralized

Provider defaults, base URLs, models, and OpenRouter headers live in `src/agent-harness/models.ts`. Custom origins already use optional host permission requests in the Options page (`src/options/Options.tsx:781-797`). The missing piece is credential scope and capability validation, not a second provider registry.

### 4.5 UI integration is contained

`AgentPanel` and `useBgsmAgent` keep Agent-specific rendering and behavior outside the already large `ManagerPanel`. The implementation uses the existing ShadowRoot, theme tokens, Portal context, i18n catalog, and component primitives.

## 5. Source-of-truth invariants

Any remediation must preserve these repository rules.

### 5.1 Storage ownership

- IndexedDB owns stars, tags, and tag metadata.
- `chrome.storage.local` owns lightweight config, provider settings, UI state, and future run metadata that does not need large relational queries.
- GitHub owns remote repository metadata.
- Gist is a transport for tags/tag metadata, not the primary write source.

### 5.2 Tag layers

A `Tag` has three independent layers (`src/types/index.ts:74-86`):

- `manualTags`: user-owned or explicitly accepted tags;
- `autoTags`: generated tags;
- `dismissedAutoTags`: generated tags the user removed.

`visibleTagNames` is a display union, not a valid replacement payload for the manual layer (`src/tags/tag-model.ts:21-35`).

### 5.3 Exclusion tombstones

`TagMeta.excluded` means a globally deleted tag must not be regenerated until the user manually re-adds it. A model-driven assignment is not automatically equivalent to a user-owned manual re-add. The write policy must make that distinction explicit.

### 5.4 Tombstoned stars

Product behavior applies to currently starred repositories by default. Agent read and write tools must reject tombstoned rows unless a future, explicitly named historical capability is added.

## 6. Blocking findings

### A-01 — Critical: provider credentials are not scoped to provider/origin

#### Evidence

- `AgentProviderConfig` stores one encrypted key with the selected provider config.
- `updateAgentProviderConfig` preserves the current encrypted key when provider, base URL, or model changes without a new key (`src/auth/auth-store.ts:293-333`).
- Connection testing uses a typed key if present, otherwise it falls back to the globally saved Agent key (`src/background/index.ts:171-184`).
- The Options page enables Test when either the text field or any saved Agent key exists (`src/options/Options.tsx:272-275`).

#### Failure mode

A user can save an OpenAI key, switch the form to a custom service, leave the key field empty, and test the new origin. The background combines the new provider/base URL with the old saved key and sends it as a Bearer token.

Custom-host permission does not solve this problem. It authorizes the network origin; it does not authorize reuse of a credential minted for another service.

#### Required outcome

Persist a credential scope alongside the encrypted key:

```ts
type AgentCredentialScope = {
  provider: AgentProviderId;
  origin: string;
};
```

Rules:

- normalize the origin before comparing or storing it;
- provider or origin changes invalidate fallback to the saved key;
- a mismatched key requires explicit re-entry;
- Save and Test use the same canonical scope function;
- clearing the key clears the scope;
- add regression tests for provider switching, custom-origin switching, and saved-key fallback.

A multi-key credential vault is not required for the first release.

### A-02 — Critical: model-facing write permissions are unconditional

#### Evidence

- The generic harness defaults write tools to `approval_required` (`src/agent-harness/permissions.ts`).
- `runBgsmAgentTurn` replaces that evaluator with `permissions: () => ({ type: 'allow' })` (`src/background/index.ts:225-232`).
- The visible registry includes `remove_repo_tag` and `delete_tag_everywhere` (`src/bgsm-agent/tools.ts:7-15`).
- The current test explicitly locks in allow-all behavior (`tests/unit/background-agent-run-contract.test.ts:30-34`).

#### Risk

Prompt wording is the only remaining protection against destructive calls. Repository descriptions, topics, and notes are external data, not trusted instructions. **[INFERENCE]** A malicious or accidental instruction embedded in retrieved data can influence the model toward a write tool because runtime policy does not independently enforce user intent.

The global delete validator also accepts a string that becomes empty after trimming (`src/bgsm-agent/tools.ts:214-220`). The store then persists an exclusion tombstone even when no repository was changed (`src/storage/idb-tag-store.ts:297-309`).

#### Required outcome

Replace allow-all with capability-specific policy:

```ts
type BgsmAgentCapability =
  | 'inspect'
  | 'auto_tag_scope'
  | 'cleanup_proposal'
  | 'delete_tag_commit';
```

Policy must enforce:

- visible tool set;
- exact repository scope;
- allowed operation types;
- maximum write calls and affected rows;
- non-empty normalized tag names;
- excluded-tag behavior;
- approval requirements;
- a structured denial result for every rejected call.

The model may describe the policy, but code must own the decision.

### A-03 — Critical: assignment corrupts manual/auto tag provenance

#### Evidence

`assign_repo_tags` reads `visibleTagNames(existing)`, adds the proposed tags, and passes the resulting union to `idbTagStore.setTags` (`src/bgsm-agent/tools.ts:142-155`).

`setTags` is explicitly a manual-layer replacement operation (`src/storage/idb-tag-store.ts:110-123`). `visibleTagNames` combines manual and auto layers (`src/tags/tag-model.ts:33-35`).

#### Failure mode

If a repository already has auto tags and the Agent adds one manual tag, all existing auto tags are written into `manualTags`. This changes:

- provenance;
- auto-tag dismissal behavior;
- layer modification times;
- future Gist merge behavior;
- the meaning of subsequent manual edits.

#### Required outcome

- Base additive manual assignments on `manualTagNames(existing)`, not the visible union.
- Return visible tags separately when the UI needs the combined result.
- Decide whether Agent-generated tags belong in `manualTags` or `autoTags`; do not switch implicitly between those semantics.
- Add mixed-layer regression coverage: manual, auto, dismissed, excluded, and Gist dirty state.

### A-04 — High: excluded tags can be silently resurrected

#### Evidence

- `list_tags` removes excluded names from model-visible output (`src/bgsm-agent/tools.ts:25-34`).
- The system instruction says excluded names must not be suggested again.
- The current run does not inject `buildBgsmAgentContext`, so the model does not actually receive the excluded names.
- `setTags` clears a tombstone for a newly added manual tag (`src/storage/idb-tag-store.ts:124-132`).

#### Required outcome

- Enforce exclusion in the assignment tool or commit executor.
- A model suggestion cannot clear `excluded` by itself.
- Clearing an exclusion must require a distinct user-owned action or an approved proposal that states the effect.
- Return a structured `excluded_tag` denial so the model can explain the skip.

### A-05 — High: provider timeout and success parsing fail open

#### Evidence

- The request timeout is canceled immediately after `fetch` resolves, before `response.json()` reads the body (`src/agent-harness/providers/openai-compatible.ts:115-159`).
- Canceling removes the outer abort listener (`src/agent-harness/providers/openai-compatible.ts:188-214`).
- JSON parse failures become `null`.
- A missing `choices[0].message` becomes `{ content: '' }` (`src/agent-harness/providers/openai-compatible.ts:295-308`).
- A connection test replaces empty content with `OK` (`src/agent-harness/providers/openai-compatible.ts:84-101`).
- The loop treats a response with no tool calls as `final_answer` (`src/agent-harness/agent-loop.ts:64-79`).

#### Failure modes

- A server can send response headers and stall the body after the timeout has been removed.
- A `200` HTML login page, empty JSON object, malformed JSON, or error-shaped success body can be reported as a connected service.
- **[INFERENCE]** A stalled body can hold the shared serialized runner indefinitely because the provider promise never settles.

#### Required outcome

- Apply one deadline across headers, bounded body read, parse, and validation.
- Preserve outer cancellation until the full response has been consumed.
- Distinguish user abort from timeout.
- Reject missing choices, missing messages, malformed tool calls, refusal, and unsupported finish reasons.
- Do not synthesize `OK` for empty output.
- Separate connection checks:
  - chat response reachable;
  - BGSM tool round-trip supported.
- Add tests for header-only stalls, invalid JSON, 204, 200 error envelopes, missing choices, malformed tool arguments, abort after headers, and tool capability failure.

### A-06 — High: the primary Auto Assign task cannot enumerate the library reliably

#### Evidence

`search_stars`:

- requires a query;
- defaults to 20 rows;
- caps at 50 rows;
- has no cursor or continuation token (`src/bgsm-agent/tools.ts:39-77`).

The run has at most eight model steps (`src/background/index.ts:225-246`). There is no `list_stars`, `list_untagged_stars`, or current-filter scope tool.

#### Required outcome

Add a compact, stable pagination contract, for example:

```ts
type ListStarsInput = {
  scope: 'current_filter' | 'all_live';
  tagState?: 'untagged' | 'any';
  cursor?: string;
  limit?: number;
};

type ListStarsResult = {
  stars: AgentStarSummary[];
  nextCursor: string | null;
  totalInScope: number;
};
```

`AgentStarSummary` should contain only necessary public metadata. The UI must show the chosen scope and count before a whole-library job starts.

Current Auto Tags preferences also need a product decision:

- `maxTagsPerRepo` should become a hard validator limit;
- `minTopicRepoCount` must either feed a deterministic task/tool or be removed from the UI and config;
- the hard-coded eight-tag tool cap (`src/bgsm-agent/tools.ts:275-285`) must not silently replace the user preference.

### A-07 — High: Enter-to-send is blocked in the real ShadowRoot

#### Evidence

The content script installs a capture-phase `keydown` listener on the ShadowRoot and calls `stopPropagation` for textarea events (`src/content/stars-page/index.tsx:88-93`).

The composer handles Enter on the descendant textarea (`src/ui/ai-elements/chat.tsx:98-102`). A capture listener on the ancestor stops the event before it reaches that target.

The current AgentPanel test submits by clicking the Send button and does not cover the extension ShadowRoot (`tests/unit/agent-panel.test.tsx:99-144`).

#### Required outcome

- Stop GitHub-level keyboard leakage after the React target handler has run, not during capture before the target.
- Verify:
  - Enter submits;
  - Shift+Enter inserts a newline;
  - IME composition does not submit;
  - GitHub document shortcuts do not receive the event;
  - the behavior runs inside the actual ShadowRoot host.

### A-08 — High: model data sharing contradicts published privacy claims

#### Evidence

`inspect_tag` returns `tagRecord`, which is the full `Tag` row (`src/bgsm-agent/tools.ts:80-109`). `Tag` contains notes and other annotation-layer fields (`src/types/index.ts:74-86`). Tool results are serialized back into the next model request (`src/agent-harness/agent-loop.ts:91-100`; `src/agent-harness/providers/openai-compatible.ts:266-271`).

The privacy policy currently says:

- the extension communicates only with GitHub and the GitHub API;
- extension data is shared only with GitHub services;
- no third party receives extension data (`docs/privacy-policy.md:51-63`).

The manifest now grants required host access to OpenAI and OpenRouter and optional broad access for a user-selected custom service (`manifest.config.ts:22-33`).

#### Required outcome

- Introduce provider-visible DTOs; never return raw storage records.
- Exclude notes by default.
- If a future feature needs notes, expose a separate capability with explicit disclosure and user consent.
- Bound result counts and string lengths.
- Update the privacy policy, Chrome Web Store disclosures, and in-product first-use copy before release.
- State which data categories may be sent:
  - user prompt;
  - repository name and public metadata;
  - selected tag taxonomy;
  - mutation/tool observations.
- State which data is not sent by default:
  - notes;
  - encrypted credentials;
  - GitHub token;
  - unrelated stars outside the selected scope.
- Reconsider whether OpenAI and OpenRouter must be required host permissions or can also be requested when the user enables that provider.

### A-09 — High: the complete test suite is not green

The audit baseline observed:

```text
pnpm test
1 failed | 66 passed
```

The failing contract imported `src/background/index.ts` with a Chrome mock that did not define `chrome.runtime.onConnect`. The new Port listener is registered at `src/background/index.ts:711`.

#### Required outcome

- Extend the shared Chrome test harness with a real-enough `runtime.onConnect` mock.
- Do not hide the issue in product code with optional chaining; MV3 production legitimately requires this API.
- Add behavioral Port tests for start, event forwarding, result, provider error, disconnect, and abort.
- Require the complete test suite to pass before merge.

## 7. Important non-blocking findings

### B-01 — Remediated: bounded conversation continuity

The provider now receives bounded durably stored history plus an optional compaction checkpoint. Follow-ups remain session-bound and CAS-protected; flat sessions rehydrate from background-owned IndexedDB while branching session trees remain intentionally absent.

- Keep correctness grounded in current IndexedDB reads and receipts, not memory.
- Preserve drafts and offer a new-conversation recovery when the current suffix cannot fit.
- Keep transient streaming, progress, and optimistic drafts out of durable history.

### B-02 — Remediated: typed Provider streaming

Chat Completions, Responses, and Anthropic adapters now emit typed text deltas before the final message. Tool arguments remain hidden until complete and valid. The UI still presents observable activity rather than hidden chain-of-thought.

Use `Activity`, not `Reasoning`, for observable facts:

- searching local stars;
- inspecting a tag;
- validating a proposed change;
- applying a confirmed mutation;
- producing a result.

Do not expose hidden chain-of-thought.

### B-03 — Remediated: typed terminal recovery

The Port validates stop reasons, write uncertainty, and exact context failure categories. The UI distinguishes retry-safe Provider/summary failures, capability settings failures, preserved-draft new-conversation recovery, abort, and successful completion.

The UI must render separate recovery actions for:

- success;
- no changes;
- partial mutation;
- permission denial;
- step budget reached;
- timeout;
- user abort;
- provider failure.

### B-04 — Tool cards hide evidence and outcomes

Successful tool output is reduced to `Done` (`src/ui/components/AgentPanel.tsx:161-175`). The user cannot see which repositories changed, what was skipped, or whether a global delete affected zero or many rows.

Display deterministic summaries from structured receipts, not only the model’s prose.

### B-05 — Close and stop semantics are unclear

The X control says close, but closing unmounts the hook, disconnects the Port, and aborts the run. The interface should either:

- label it Stop while running and Close while idle; or
- keep session state above the panel so Hide can preserve an active run and a toolbar indicator can reopen it.

### B-06 — Global queue ownership is too broad

The entire provider/model/tool loop runs through the same serialized background runner used by sync-related operations (`src/background/index.ts:745-748`). A slow network model should not block unrelated data work.

Recommended boundary:

- model calls and read-only planning execute outside the global write queue;
- only the final deterministic IndexedDB commit enters the serialized mutation path;
- the commit revalidates preconditions after waiting for the queue.

### B-07 — The Dexie v4 bump is a no-op

`src/storage/db.ts:43-48` adds a v4 schema identical to v3 and describes Agent experiments. Provider config lives in `chrome.storage.local`, so this does not need a Dexie version bump.

Because the feature is unreleased, remove the no-op version. If persistent Agent records are later approved, modify the unreleased v4 directly rather than inventing a v5 for local experimental data.

### B-08 — Several surfaces are stale or unused

Candidates to remove or connect before merge:

- `buildBgsmAgentContext`, whose approval/excluded-tag claims do not reach the active prompt;
- the duplicate `startBgsmAgentTurn` runtime-message path if the Port is canonical;
- provider model-list APIs that have no UI consumer;
- configuration copy for behavior settings that no longer affect Agent execution;
- old proposal-specific i18n and documentation if the product no longer ships that workflow.

Use one canonical transport, one runtime entry point, and one product contract.

### B-09 — Accessibility and visual hierarchy need a dedicated pass

Current issues:

- the drawer lacks explicit dialog/complementary semantics, focus entry, focus return, Escape behavior, and `aria-expanded` ownership;
- the composer textarea has a placeholder but no persistent accessible label;
- its visible focus ring is removed without a `focus-within` replacement;
- the transcript is not a labelled log or live region;
- the close button does not communicate that it aborts a running task;
- cards are nested inside assistant bubbles, creating unnecessary visual layers;
- successful activity and authoritative results are not visually distinct.

The target should remain GitHub-native and border-led, with one dominant task/result surface rather than a generic assistant chat aesthetic.

### B-10 — Bundle cost should be paid on demand

The audited build passed but reported a large JavaScript chunk after adding Streamdown and Agent UI. Lazy-load the panel and markdown renderer when the user first opens Cubby. Verify that the content-script CSS build still contains no runtime `@import`.

## 8. Target architecture

```text
Agent Workbench
  -> AgentSessionController
      -> BgsmContextBuilder
      -> BgsmAgentEngine
          -> ProviderAdapter
          -> CapabilityRegistry
      -> BgsmPermissionPolicy
      -> BgsmCommitExecutor
          -> idbTagStore
          -> MutationReceipt
```

### 8.1 `AgentSessionController`

Owns:

- one active run;
- user-selected capability and scope;
- cancellation;
- UI lifecycle state;
- transcript/run separation;
- recovery actions;
- Port reconnect behavior if persistent runs are later added.

It should live above the presentational panel so Hide preserves a run. Durable chat history is stored separately from run presentation and never owns Organize recovery authority.

### 8.2 `BgsmContextBuilder`

Builds a bounded context from authoritative application state:

1. stable product instructions and policy summary;
2. selected capability and immutable scope;
3. active limits;
4. known excluded-tag policy without exposing unnecessary records;
5. current user task;
6. just-in-time tool observations.

Repository descriptions, topics, notes, and future connector content are wrapped as untrusted data.

### 8.3 `BgsmAgentEngine`

Owns the provider-neutral loop and does not write storage directly. It must return a typed terminal result:

```ts
type AgentRunOutcome =
  | { status: 'completed'; answer: string; receipt: MutationReceipt | null }
  | { status: 'no_changes'; answer: string }
  | { status: 'approval_required'; proposal: ProposedActionSet }
  | { status: 'denied'; reason: string }
  | { status: 'aborted'; receipt: MutationReceipt | null }
  | { status: 'failed'; stage: 'provider' | 'tool' | 'commit'; message: string };
```

### 8.4 `BgsmPermissionPolicy`

Receives trusted runtime state, not just a model tool call:

```ts
type BgsmPermissionContext = {
  capability: BgsmAgentCapability;
  allowedRepos: ReadonlySet<string>;
  excludedTags: ReadonlySet<string>;
  remainingWriteCalls: number;
  remainingAffectedRows: number;
  approvalToken?: string;
};
```

It returns allow, deny, or approval required. A model message cannot mint an approval token.

### 8.5 `BgsmCommitExecutor`

The only component allowed to execute domain writes for the Agent. It:

- reloads current rows;
- validates source preconditions;
- applies one bounded transaction where atomicity is required;
- preserves manual/auto/dismissed layers;
- marks Gist dirty state through existing store APIs;
- emits a receipt based on actual writes;
- reports conflicts rather than silently overriding newer user edits.

## 9. Minimal data contracts

### 9.1 Provider-visible repository DTO

```ts
type AgentStarSummary = {
  fullName: string;
  description: string;
  language: string | null;
  topics: string[];
  archived: boolean;
  fork: boolean;
  visibleTags: string[];
};
```

Constraints:

- omit notes and storage modification times;
- cap description and topic lengths;
- omit tombstoned stars;
- return only rows inside the selected scope;
- include a stable cursor for pagination.

### 9.2 Proposed action

```ts
type ProposedTagAction =
  | {
      kind: 'add_repo_tags';
      fullName: string;
      tags: string[];
      evidence: string[];
    }
  | {
      kind: 'remove_repo_tag';
      fullName: string;
      tag: string;
      evidence: string[];
    }
  | {
      kind: 'delete_tag_everywhere';
      tag: string;
      expectedRepos: string[];
    };
```

The first safe release may keep additive actions in memory and apply them immediately within policy. Removal and global delete require a reviewable proposal.

### 9.3 Mutation receipt

```ts
type MutationReceipt = {
  runId: string;
  capability: BgsmAgentCapability;
  startedAt: string;
  completedAt: string;
  attempted: number;
  applied: Array<{
    fullName: string;
    added: string[];
    removed: string[];
  }>;
  skipped: Array<{
    target: string;
    code: 'out_of_scope' | 'excluded_tag' | 'stale_source' | 'no_change';
  }>;
  failed: Array<{
    target: string;
    code: string;
    message: string;
  }>;
};
```

OrganizeJob receipts are persisted in IndexedDB with the job and exposed through bounded pages. They survive panel closure, MV3 worker restart, and deletion of their origin conversation. Cubby retains at most one completed or cancelled Organize result; Dismiss or admission of the next job removes that terminal evidence transactionally. The UI never reconstructs receipts from transient events or model prose.

## 10. Runtime and concurrency model

### 10.1 Run sequence

```text
1. User starts Organize and confirms the complete live starred library.
2. Background freezes every current live repository into a durable IndexedDB job.
3. The analysis runner reads bounded pages and sends minimized metadata to the configured Provider.
4. Provider results are validated and persisted as actionable or non-actionable rows.
5. Budget exhaustion creates an internal continuation; alarms and leases recover unfinished work after MV3 worker restart.
6. Complete analysis exposes a durable, paged Review. No tag has changed yet.
7. User selection is persisted with revision checks, then sealed into one durable Apply.
8. The executor reloads authoritative rows, validates preconditions, and commits in bounded chunks.
9. Every attempted row is persisted in one paged receipt with changed, unchanged, skipped, or failed outcome.
10. UI renders job progress, Review, and Receipt from IndexedDB-backed presentation messages.
```

### 10.2 Budgets

Every run needs independent operational and context limits:

- total run deadline;
- provider request deadline including response body;
- maximum model steps;
- maximum read pages;
- maximum tool calls;
- maximum write calls;
- maximum affected repositories;
- maximum tags added per repository;
- provider context window from versioned capability metadata;
- optional reducing-only working window;
- requested output and safety reserves;
- soft compaction and hard admission limits;
- dynamic per-result allowance after schemas, active messages, Provider usage, and sibling envelopes;
- independent 64 KiB service-worker result-memory ceiling.

Every admitted result must leave a protocol-complete next projection within the hard limit. Live JSON is never substring-truncated. A limit breach produces a typed terminal state and preserves write uncertainty if a mutation may already have committed.

### 10.3 Abort semantics

- Check abort before each provider call.
- Check abort before each tool call.
- Pass the signal through tool execution.
- Do not start a new write transaction after abort.
- A transaction already committing should finish atomically, then return the receipt.
- Closing, hiding, stopping, and navigating away must have separately documented behavior.

### 10.4 Conversation and workflow ownership

Conversation lifetime, workflow lifetime, and page control are independent:

- `originAgentSessionId` is immutable provenance. It may name a deleted conversation and is never a routing or authorization key.
- A nonterminal job's durable `controllerId` / `sessionId` plus a matching live Organize Port define the single `owner`. Other pages are `observer`; if the owner disconnects they become `owner_lost`.
- Port connectivity and per-page role are worker-epoch projections, not persisted facts. Reconnect, restore, snapshot fetch, paging, and conversation switching are read-only with respect to durable control.
- An `owner_lost` page can become owner only through an explicit revision-checked Take control command. The live-Port check and storage CAS are linearly ordered, and takeover does not restart in-flight Provider work merely to rewrite an ephemeral runner identity.
- Owner-only mutation and observer-safe reads are separate capabilities. Review/receipt paging, ordinary chat, and page-local conversation selection do not grant workflow mutation authority.
- Completed/cancelled and no-job projections have no owner role. The latest terminal result is global, does not lock conversation controls, and can be dismissed from any page by exact job/revision identity.
- Background fan-out occurs only after the durable transaction commits. Dismiss, replacement, takeover, disconnect role changes, and successful conversation deletion converge every subscribed page; a rejected deletion publishes no invalidation.

`deleteAgentSession()` is the application deletion boundary. It uses indexed origin/current-session lookups, rejects every linked nonterminal job, preserves terminal job/Apply/receipt rows and immutable provenance, deletes only conversation-owned Agent rows, then publishes a session-specific invalidation. Pages remove the deleted catalog projection, preserve unsent composer input, and select or create a valid conversation without writing to the deleted session.

## 11. Target interaction model

The primary surface should be a task workbench. Free-form chat remains useful as a secondary request surface.

```text
Header
  Cubby
  Provider/model
  Scope: Current filter · 32 repositories
  Run status
  Hide / Stop

Ready state
  Auto-tag scoped repositories
  Inspect tag landscape
  Clean up tags

Active run
  User task
  Activity log
    Searched 32 local repositories
    Inspected 7 existing tags
  Proposal or mutation receipt
  Skips, conflicts, and recovery actions

Footer
  Labelled task composer
```

### 11.1 UI state machine

```text
closed
  -> ready
  -> queued
  -> reading
  -> proposing
  -> awaiting_approval
  -> committing
  -> completed | no_changes | denied | aborted | failed
```

Rules:

- only one state is authoritative;
- every terminal state has one clear next action;
- `Hide` keeps a run alive only if state is owned above the panel;
- `Stop` cancels pending provider/tool work;
- `Close` is only used when idle or terminal;
- the toolbar shows an active/error/completed indicator when the panel is hidden;
- conversation continuity is not implied until the provider receives bounded prior turns.

### 11.2 Accessibility acceptance

- Focus enters the panel at its heading or first task control.
- Escape follows documented Close/Stop behavior.
- Focus returns to the toolbar trigger.
- The trigger exposes `aria-expanded` and `aria-controls`.
- The transcript uses a labelled log or appropriate live announcement strategy.
- The composer has a persistent accessible name.
- Focus indication remains visible in light and dark themes.
- Status is not communicated by color alone.
- Motion respects reduced-motion preferences.

## 12. Provider compatibility contract

“OpenAI-compatible” must mean a documented subset, not every service with a similar URL.

### 12.1 Required protocol profiles

- HTTPS, except explicit localhost development endpoints;
- Bearer token authentication;
- Chat Completions, Responses, or Anthropic Messages according to the selected profile;
- bounded SSE streaming with explicit terminal events;
- modern `tools` and `tool_choice` request fields;
- assistant `tool_calls` and tool-call IDs;
- explicit model identifier;
- bounded response body;
- valid finish/stop state.

### 12.2 Provider capabilities

The Provider profile owns protocol and endpoint identity. Context authorization is a separate versioned `AgentModelContextCapability` containing context window, maximum output, source, source revision, and capability revision. Known built-ins use current official metadata. Unknown Custom and `openrouter/auto` routes require an explicit declared context window; no 8192 fallback is permitted. A working-window preference can reduce but never increase the provider window.

The current connection test proves text and named-tool round trips. It does not infer a maximum context window. `provider-verified` remains a reserved future capability source until a Provider-specific metadata endpoint can bind model identity, capacity, revision, and expiry reliably; current runtime producers are `builtin-official` and `user-declared`.

### 12.3 Connection verification

A successful test must prove:

1. URL and host permission are valid;
2. credential scope matches;
3. the service returns a valid assistant response;
4. the selected model can complete a minimal tool-call round trip;
5. response parsing and timeouts behave correctly.

A Provider overflow invalidates the capability bound to the active Provider fingerprint. It does not infer a replacement window; the user must correct the declaration or run a new valid connection test.

## 13. Security and privacy model

### 13.1 Trust classes

| Data | Trust | Treatment |
| --- | --- | --- |
| Product instructions and runtime policy | Trusted | Stable prompt prefix and code enforcement |
| User task | Authorized intent, not blanket permission | Bound to selected capability and scope |
| GitHub descriptions/topics | Untrusted external data | Data-only delimiters; cannot override policy |
| User notes | Private untrusted data | Not sent by default |
| Tool arguments from model | Untrusted | Strict local schema validation |
| Tool results | Application observations | Minimized before returning to provider |
| Provider response | Untrusted | Strict envelope and semantic validation |
| API key/GitHub token | Secret | Never enters prompts, logs, tool results, or UI receipts |

### 13.2 Required threat probes

- prompt injection in repository descriptions and topics;
- prompt injection in notes if a future notes capability is enabled;
- model attempts to call hidden or destructive tools;
- tool argument overflows and unknown fields;
- out-of-scope repository writes;
- excluded-tag resurrection;
- stale data between proposal and commit;
- credential reuse after provider/origin change;
- malformed provider responses;
- provider timeout after headers;
- Port disconnect during reads and writes;
- Gist merge after Agent-generated mutations.

### 13.3 Logging rules

Allowed operational trace fields:

- run ID;
- capability;
- provider ID and model ID;
- timing and token usage when supplied;
- tool name, duration, status, and aggregate counts;
- terminal reason;
- receipt counts.
- selected provider and working windows, soft/hard limits, and capability/policy revisions;
- deterministic estimate, Provider usage adjustment, remaining context, and tool allowance bytes;
- bounded compaction trigger, retry, fallback, limiting-factor, and terminal categories.

Do not log:

- API keys or GitHub tokens;
- full prompts by default;
- notes;
- full repository descriptions;
- raw provider response bodies containing user data;
- hidden model reasoning.
- repository names, code snippets, tool payloads, headers, and raw Provider errors in context diagnostics.

## 14. Test and evaluation plan

### 14.1 Unit tests

#### Agent loop

- final answer without tools;
- unknown tool result;
- invalid arguments;
- permission deny;
- approval required;
- abort before provider call;
- abort between parallel/sequential tool calls;
- step budget reached;
- provider failure and explicit stop reason;
- every tool call receives a tool result.

#### Provider

- valid text response;
- valid tool-call response;
- malformed tool-call arguments;
- missing choices/message;
- invalid JSON and HTML body;
- 204 response;
- 200 error envelope;
- non-2xx structured error;
- timeout before headers;
- timeout during body;
- outer abort during body;
- provider-specific token field;
- tool round-trip connection test;
- credential-scope mismatch.

#### Domain tools and policy

- manual/auto/dismissed layers remain distinct;
- excluded names are denied;
- empty and case-variant tags normalize safely;
- repository scope is enforced;
- tombstoned rows are rejected;
- per-repo and per-run budgets are enforced;
- pagination is deterministic;
- notes are absent from provider DTOs;
- global delete requires approval and current impact validation.

#### UI reducer

- every event causes a valid state transition;
- stop reasons remain distinct;
- duplicate events are idempotent;
- stale run events cannot update a newer run;
- partial receipts survive abort/failure rendering.

### 14.2 Integration tests

- bounded additive auto-tag operation over fake IndexedDB;
- mixed tag layers and Gist dirty tracking;
- exclusion policy across assignment and manual re-add;
- proposal preview followed by confirmed removal;
- stale-source conflict before global delete;
- commit transaction atomicity;
- provider config normalization and credential scope;
- Chrome Port start/event/result/error/disconnect behavior.

### 14.3 Extension runtime and browser tests

- open Agent panel from the toolbar;
- Enter submits in the actual ShadowRoot;
- Shift+Enter and IME work;
- GitHub shortcuts do not receive composer events;
- Stop aborts the run;
- Hide/reopen behavior matches the product contract;
- focus entry, Escape, focus return, and narrow viewport behavior;
- no-token and missing-Agent-key recovery;
- permission request for custom endpoints;
- successful provider tool round trip using a controlled replay fixture;
- existing stars, repo-chip, sync, and onboarding smoke scenarios remain green.

### 14.4 Adversarial eval set

Maintain deterministic replay fixtures for:

- clear high-signal tag assignments;
- ambiguous repositories that must be skipped;
- existing taxonomy preference;
- archived/fork/tombstoned boundaries;
- injection text asking the model to delete tags or reveal secrets;
- large libraries requiring pagination;
- provider truncation and malformed output;
- removal requests with ambiguous scope;
- global delete with a changed repository set.

Score:

- unsafe write rate;
- out-of-scope write rate;
- excluded-tag resurrection rate;
- precision of applied tags;
- skip correctness;
- task completion rate;
- recovery quality;
- latency and provider request count.

## 15. Phased implementation plan

### Phase 0 — Restore a truthful, safe baseline

Deliverables:

1. bind saved credentials to provider/origin;
2. fix manual/auto layer preservation;
3. enforce excluded-tag policy;
4. replace allow-all permissions;
5. reject malformed provider successes and cover the full response deadline;
6. fix ShadowRoot Enter handling;
7. minimize provider-visible data;
8. update privacy and Chrome Web Store disclosures;
9. remove the no-op Dexie v4 and stale dead paths;
10. make the complete test suite green.

Acceptance:

- no model-only destructive write path;
- no credential can cross provider/origin without re-entry;
- mixed-layer regression tests pass;
- no notes leave the extension in default Agent flows;
- `pnpm typecheck` and `pnpm test` pass.

### Phase 1 — Ship a bounded task workbench

Deliverables:

- explicit Inspect and Auto-tag capabilities;
- immutable complete-library scope and stable pagination;
- runtime budgets;
- additive direct writes only inside policy;
- deterministic mutation receipts;
- typed terminal outcomes;
- honest Activity UI;
- Stop/Close semantics;
- lazy-loaded Agent UI;
- focused runtime and browser coverage.

Acceptance:

- Organize can process every frozen live star without silently dropping rows;
- every applied change appears in a receipt;
- every skip has a structured reason;
- out-of-scope and excluded writes are mechanically denied;
- Agent browser tests pass in the real extension host.

### Phase 2 — Add reviewable cleanup and durable recovery

Deliverables, only after Phase 1 metrics justify them:

- removal and global-delete proposal UI;
- source snapshots and precondition validation;
- durable action receipts are already part of OrganizeJob; extend the same authority model to any future destructive capability;
- most-recent-action undo if product requirements still demand it;
- flat persistent conversation resume is complete; add branching session trees only if later product evidence justifies them.

The unreleased v4 now contains `agentSessions` and `agentMessages`; existing development profiles created with the older v4 layout must reset IndexedDB once.

Acceptance:

- stale proposals fail safely;
- apply is atomic where promised;
- undo never overwrites later user edits;
- persisted state can be rehydrated without relying on chat prose.

### Phase 3 — Add skills and connectors only from measured need

Potential capabilities:

- built-in, versioned task skills such as `organize-tags`, `cleanup-taxonomy`, and `inspect-stars`;
- read-only external connectors;
- progressive tool discovery;
- additional provider dialects.

Defer until single-Agent evals demonstrate need:

- multi-agent orchestration;
- MCP/Web Bridge;
- user-authored arbitrary skills;
- autonomous background goals;
- broad remote write connectors;
- full coding-agent session trees and opaque Provider compaction state.

## 16. Merge gates

The feature is merge-ready only when every required item is checked.

### Security and privacy

- [ ] Saved key is bound to provider and normalized origin.
- [ ] Provider/origin changes cannot reuse a mismatched key.
- [ ] Destructive tools cannot execute from model intent alone.
- [ ] Repository scope and write budgets are enforced in code.
- [ ] Excluded tags cannot be resurrected by model assignment.
- [ ] Provider-visible DTOs omit notes by default.
- [ ] Privacy policy and store disclosures include AI providers and data categories.
- [ ] Required and optional host permissions match actual enablement behavior.

### Domain correctness

- [ ] Agent assignment preserves manual, auto, and dismissed layers.
- [ ] Tombstoned repositories are excluded.
- [ ] Gist dirty tracking and merge semantics are covered.
- [ ] Global deletion validates current affected repositories.
- [ ] Mutation receipts reflect actual rows and deltas.

### Provider reliability

- [ ] Deadline covers headers, body, parse, and validation.
- [ ] User abort remains active through response consumption.
- [ ] Malformed success responses fail closed.
- [ ] Connection Test verifies a tool-capable response.
- [ ] Provider capability differences are explicit.
- [ ] Built-in context limits cite current Provider evidence; unknown routes have no implicit fallback.
- [ ] Working caps only reduce capacity and Provider usage only tightens admission.
- [ ] Every admitted tool result leaves a protocol-valid next projection inside the hard limit.
- [ ] Completed-envelope compaction preserves the active user/tool suffix verbatim.
- [ ] Provider overflow invalidates the fingerprint-bound connection capability.

### Product and accessibility

- [ ] UI states distinguish success, no change, denial, abort, timeout, and failure.
- [ ] Conversation memory is not implied unless implemented.
- [ ] Enter, Shift+Enter, and IME work in the ShadowRoot.
- [ ] Close/Hide/Stop behavior is explicit.
- [ ] Focus entry, focus return, Escape, labels, and announcements are verified.
- [ ] Agent code is lazy-loaded or its bundle cost is explicitly accepted.

### Verification

- [ ] `pnpm typecheck`
- [ ] `pnpm test:logic`
- [ ] `pnpm test:integration`
- [ ] `pnpm test:regressions`
- [ ] `pnpm test:runtime`
- [ ] `pnpm test:smoke`
- [ ] Agent-specific ShadowRoot browser scenario
- [ ] Prompt-injection and malformed-provider eval fixtures
- [ ] Context diagnostic allowlist and secret/content canaries
- [ ] Production extension Custom capacity, large-result, compaction, cancellation, and Provider-switch scenarios

## 17. Pi patterns to borrow selectively

The local Pi implementation is useful as a reference for boundaries, not as a
dependency. For provider work in P1, P3, P4, and context budget/compaction v2, reviewing and recording the
mapped Pi comparison is mandatory under the
[Pi source reference contract](./plans/agent-provider/pi-source-reference.md);
adopting any particular Pi behavior remains selective and subordinate to BGSM
invariants and current official provider schemas.

### Context budget and compaction v2

Automatic context compaction is now implemented at two legal boundaries:
before a turn and after a complete assistant-tool envelope. Capacity is derived
from versioned model capability metadata plus an optional reducing-only working
cap. GPT-5.4 uses the official 1,050,000-token context window and 128,000-token
maximum output; 272K is a pricing threshold, not the context limit. Unknown
Custom and automatic-router models require an explicit declared capacity rather
than silently falling back to 8192.

Provider usage can tighten the estimate but cannot expand authorization. Tool
allowances are derived dynamically from the remaining context, sibling result
envelopes, schemas, and an independent service-worker memory ceiling. Live tool
JSON is never substring-truncated. Compaction summaries receive no tools,
cannot authorize writes, and use one corrective retry followed by a strict
deterministic fallback. The Port carries exact failure categories to recovery
UI while successful compaction stays low-noise.

The comparison and release evidence are recorded in the
[Pi source reference contract](./plans/agent-provider/pi-source-reference.md).
Repository code search remains release-gated until the complete v2 verification
matrix and unpacked-Chrome scenarios are fresh.

### Borrow

- one stateful runtime owner for messages, abort, pending calls, and terminal state;
- typed lifecycle events and explicit finish reasons;
- abort propagation through provider and tool execution;
- schema validation before permission and execution;
- provider capability metadata such as token-limit field selection;
- context transforms that rebuild fresh application state;
- deterministic operational events without exposing hidden reasoning.

### Do not import for MVP

- the full provider SDK registry;
- coding-agent filesystem/session abstractions;
- branching session trees;
- Pi session trees or opaque provider compaction state;
- multi-agent orchestration;
- filesystem skills;
- MCP and Web Bridge;
- provider-specific thinking or cache machinery that BGSM does not yet need.

The rule is to borrow seams and invariants only after BGSM has a concrete requirement.

## 18. Decision record

### Decision: keep the small provider-neutral harness

Why: the existing loop is understandable and close to the product boundary. Replacing it with a broad agent framework would increase bundle size and policy surface before the current invariants are correct.

### Decision: use tiered autonomy rather than one global write rule

Why: additive scoped tagging and global deletion do not have the same risk. A single allow-all or approval-all policy either becomes unsafe or makes the primary task unnecessarily cumbersome.

### Decision: make deterministic receipts authoritative

Why: model prose cannot prove which rows changed. Receipts support honest UI, debugging, partial failure, and future undo without requiring a full audit subsystem immediately.

### Decision: keep notes private by default

Why: notes are user annotations and are not required for the first useful tagging task. Data minimization is safer than relying on disclosure alone.

### Decision: persist only canonical flat conversations

Why: create, switch, and delete controls are incomplete if refresh discards them. The background service worker now commits canonical messages, bindings, checkpoints, and projections to local IndexedDB, while streaming text, progress, optimistic drafts, credentials, and raw Provider requests remain transient.

### Rejected: prompt-only safety

Reason: prompts guide model behavior but cannot authorize local destructive writes or defend against untrusted retrieved content.

### Rejected: restoring the entire old proposal architecture before any useful release

Reason: bounded additive writes can be safe with runtime policy and receipts. Proposal/approval remains necessary for removals and broad destructive changes.

### Rejected: full Pi integration

Reason: BGSM needs a narrow browser-extension control plane, not a coding-agent runtime.

## 19. Open product decisions with recommended defaults

| Decision | Recommended default | Reason |
| --- | --- | --- |
| Where Agent-generated additive tags are stored | Choose one explicit layer; prefer `autoTags` if they remain machine-owned, `manualTags` only after explicit acceptance | Preserves provenance |
| Default Organize scope | All current live stars, confirmed before start; filters and selected rows cannot narrow it | Makes “organize my library” complete and auditable |
| Direct write for additive Auto Tags | Allowed only for explicit task invocation, immutable scope, and hard budgets | Keeps primary task useful without granting broad autonomy |
| Notes available to model | Scoped tool selected by the main model | Private note contents are read only when the current request asks to use them |
| Chat continuity | Flat local conversations with lazy transcript hydration | Follow-ups and compaction survive refresh without introducing branching or remote Provider sessions |
| Persistent Agent tables | Durable OrganizeJob/Review/Apply/Receipt plus `agentSessions` and `agentMessages`; retain at most one terminal Organize result independently of its origin conversation | MV3 recovery, explicit multi-page ownership, auditable receipts, and user-visible conversation controls require distinct local authority and atomic commits |
| Automatic Gist Push after Agent change | No | Preserves explicit sync ownership |
| OpenAI/OpenRouter host permissions | Prefer enablement-time optional permissions if UX remains acceptable | Least privilege |

## 20. Verification baseline and evidence limits

Historical evidence from the implementation audit before this document was written:

- `pnpm typecheck`: passed;
- focused Agent unit tests: 7 files / 33 tests passed;
- `pnpm build`: passed with a large-chunk warning;
- built CSS: no runtime `@import` remained;
- `pnpm test`: failed with 1 failing suite and 66 passing suites;
- `pnpm test:runtime`: passed, but covers only Puppeteer runtime availability;
- `pnpm test:smoke`: passed six base-extension scenarios and did not exercise Cubby;
- ShadowRoot keyboard reproduction: the target textarea did not receive `keydown` when the ancestor capture listener stopped propagation.

Fresh context v2 evidence from 2026-07-17:

- `pnpm typecheck`: passed;
- `pnpm test:logic`: 94 files / 1028 tests passed;
- `pnpm test:integration`: 17 tests passed, including real Dexie notes, two tool envelopes, mid-turn compaction, and continuation;
- `pnpm test:regressions`: 15 files / 664 tests passed, including 100 seeded context-budget fuzz cases;
- `pnpm test:runtime`: passed;
- `pnpm build`: passed;
- `pnpm test`: 111 files / 1678 tests plus runtime passed;
- `pnpm test:runtime:organize-job-host`: passed against the production extension with intercepted Responses SSE, capability readiness, content-free diagnostics, durable disconnect continuity, paged Review/Receipt, and custom-host denial checks;
- `pnpm test:runtime:organize-job-recovery`: passed real MV3 worker termination, Chrome alarm recovery, expired-lease retry, and durable Review completion without an open UI;
- `pnpm test:smoke`: passed the production extension browser smoke matrix;
- `git diff --check`: passed.

Conversation/workflow ownership Phase 2 evidence from 2026-08-06:

- `pnpm typecheck`: passed with 0 errors;
- focused ownership/storage/protocol/UI regression set: 13 files / 313 tests passed;
- `pnpm test:integration`: 1 file / 17 tests passed;
- `pnpm test:logic`: 133 files / 1710 tests passed;
- `pnpm test:regressions`: 15 files / 673 tests passed;
- `pnpm build`: passed after transforming 2393 modules (build `09216717-903c01-7109e8`); the existing >500 KiB advisory remains unsuppressed;
- `pnpm test:runtime:organize-job-host`: 8 packaged MV3 scenarios passed with two real extension pages in the ownership flow, 72 intercepted Responses requests, and zero live traffic;
- `pnpm test:runtime:organize-job-recovery`: 9 packaged MV3 scenarios passed with real Chrome alarm/service-worker termination recovery, 94 intercepted Responses requests, and zero live traffic;
- the packaged ownership flow proved observer rejection without mutation, explicit single-winner takeover, former-owner demotion, zero Provider replay on takeover, winning-binding preservation across continuation, terminal retention after origin-conversation deletion, post-commit invalidation, global Dismiss, and cancelled/no-Apply lease fencing.
- rendered ownership UI QA passed 66/66 checks: the real `AgentPanel`, hooks, reducer, and CSS rendered observer/owner-lost/takeover/terminal/session-menu states at 1280×800 and 640×800 in an out-of-repo fake-Chrome harness, while the real packaged Options page verified the retention note in light and dark themes;
- the rendered panel harness replaces only Chrome Port/RPC transport. Packaged two-page role arbitration, ShadowRoot/runtime boundaries, service-worker behavior, and durable storage remain covered by the packaged host rather than claimed as visual-harness evidence.

Agent turn protocol Phase 4 evidence from 2026-08-07:

- `src/bgsm-agent/turn-protocol.ts` is now the sole compile-time and runtime owner of Agent turn client/server unions, exact parsers, delivery/event/result/error/acknowledgement types, and bounded error codes; the Chrome and background files retain lifecycle authority without private wire schemas;
- launch identity now preserves `retrySourceAttemptId` through client production and background conflict fingerprints, while malformed starts still disconnect and malformed or wrong-epoch stop/ack messages remain non-authoritative;
- the background validates each fully sequenced published delivery once before replay-buffer admission and reuses the typed object for fan-out and replay;
- the independent check fixed discriminated acknowledgement construction, a client hello-path variable-shadowing defect, and two typed protocol-test fixtures before the final gates;
- `pnpm typecheck` passed with 0 errors; the focused protocol/adapter set passed 8 files / 190 tests; `pnpm test:logic` passed 138 files / 1,810 tests; and `pnpm test:regressions` passed 15 files / 673 tests;
- `pnpm build` passed after transforming 2,398 modules with build identity `6ecba87f-25456a-abd36e`; the existing large-chunk advisory remains unsuppressed;
- the packaged Scenario Lab passed all 9 fixtures with 9 trace roots, 413 events, and zero network requests, proving the shared protocol in the MV3 extension rather than only in source-level tests.

This is not yet clean-tree Release Candidate evidence. The remaining release-only gaps are a clean commit/package identity run and credential-dependent unpacked-Chrome checks against a live native Provider and the intended Custom service. The controlled packaged-host Provider proves protocol/runtime behavior without sending live traffic; it must not be described as a live Provider credential test.

No real API credential was used during the original audit. Provider conclusions are based on current source, mock tests, protocol behavior, official model/schema evidence, and the local Pi comparison. Line numbers are review anchors for this branch and may move; symbol names and stated invariants are authoritative.

## 21. Reference links

- [OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/)
- [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI Agent Safety](https://developers.openai.com/api/docs/guides/agent-builder-safety)
- [Chrome extension cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Chrome optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/2025-11-25)
