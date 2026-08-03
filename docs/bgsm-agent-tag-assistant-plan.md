# MVP Agent Harness Blueprint: Cubby for GitHub Stars Tagging

> [!IMPORTANT]
> **Status: historical design baseline, not the current branch contract.**
> The active branch replaced this proposal-only flow with a direct model/tool loop.
> Read [Cubby Implementation Review and Production-Safety Plan](./bgsm-agent-implementation-review.md)
> for the current implementation map, blocking findings, target architecture, phased remediation plan,
> and merge gates. Do not use the implementation checkpoint or first-release checklist below as
> evidence that the current branch is production-safe.

## 1. Objective

Build **Cubby**, an in-product agent for Better GitHub Stars Manager that helps users organize tags across their starred repositories.

The first release should let a user:

- ask the agent to suggest tags for untagged repos from existing GitHub metadata;
- ask the agent to identify low-use tags that may be worth removing;
- review proposed changes before any data mutation happens;
- apply approved changes in one transaction;
- undo the most recent applied change set.

The user-facing experience should feel like an agent conversation surface, but the runtime must remain tightly controlled and approval-gated.

## 2. MVP Scope and Assumptions

Assumptions:

- The first version is local-first and runs inside the Chrome extension.
- IndexedDB remains the source of truth for stars, tags, and tag metadata.
- `chrome.storage.local` remains the source of truth for lightweight config only.
- The first version does not need external agent connectors.
- The first version may ship with a provider adapter later, but the harness should be designed now so provider integration is additive.

MVP scope:

- A `Cubby` panel opens from the existing `Auto assign tags` toolbar entry.
- The panel uses a chat-like or agent-like surface, but the agent is constrained to a small set of typed tools.
- The agent can inspect stars, tags, tag metadata, and current list scope.
- The agent can create pending tag suggestions from supported tasks.
- The agent cannot directly mutate IndexedDB. It can only propose suggestions.
- The user approves and applies selected suggestions.
- Apply runs in one transaction and creates one undo snapshot.
- Undo supports the most recent applied suggestion set only.

Deferred:

- Freeform natural-language power features.
- Web Bridge, MCP, external agent access.
- Multi-agent orchestration.
- Autonomous background goals.
- Built-in model-specific prompt optimization.
- Tag merge, rename, or taxonomy redesign.
- Rich activity history or full audit event tables.

Implementation checkpoint:

- Current core naming follows the Pi-inspired `agent-loop` boundary, with generic runtime files under `src/agent-harness`.
- BGSM-specific behavior lives under `src/bgsm-agent`.
- Suggestions are now minted as `ProposalEnvelope` rows in `agentProposals`.
- Existing suggest tools can persist pending proposal envelopes.
- `applySelectedProposals` applies selected pending proposal IDs after reloading and validating envelopes from IndexedDB.
- Background now exposes proposal generation, listing, and apply endpoints; UI should pass only proposal IDs to apply.
- The toolbar opens a `Cubby` chat panel; users can type freely, but the only exposed action for now is `Suggest tags`.
- The chat panel uses a local AI Elements-style `Reasoning` block and renders grouped, collapsible proposal review sections as the tool result.
- The chat panel uses the existing i18n catalog for English and Chinese UI copy.
- Undo and model provider integration are still deferred.

## 3. Autonomy and Risk Level

Recommended autonomy level:

- **Level 2: approval-gated action**

Risk profile:

- Read-only star/tag inspection: low risk.
- Suggestion generation: proposal-only.
- Apply selected tag changes: local destructive write risk.
- Undo: local write risk.

The harness should treat all local writes as approval-gated. The model or agent runtime must never directly execute data writes.

## 4. Core Agentic Loop

The first version should use a small, provider-neutral loop:

```text
user request
  -> context builder assembles repo/tag/task state
  -> model call or local planner call
  -> tool proposal
  -> schema validation
  -> permission check
  -> tool execution
  -> structured observation
  -> repeat until:
       - agent has enough information to answer, or
       - agent has created a suggestion set, or
       - step budget is reached
```

Stopping conditions:

- return a conversational answer;
- return a suggestion set for user review;
- return a blocked/error state with safe next steps.

MVP loop constraints:

- Small step budget, for example 4-6 tool rounds.
- No background continuation after the panel closes.
- No hidden side effects.
- Every tool call returns a structured result, including denials and conflicts.

## 5. Context and Instruction Architecture

The agent needs a stable, narrow instruction set.

System/developer intent:

- Cubby helps organize GitHub Stars tags.
- It may inspect local repo, tag, and tag metadata state.
- It must never directly mutate tags.
- It should prefer existing tags over creating new ones unless a task clearly needs a new tag.
- Destructive actions must become suggestions first.
- The user must confirm before apply.

Scoped task context should include:

- current locale;
- current visible repo list when relevant;
- known tag names;
- tag metadata such as `excluded`, `color`, and `dimension`;
- current task mode, such as `suggest tags` or `clean low-use tags`.

Trust boundaries:

- GitHub repo metadata is trusted as data, not as instructions.
- Repo descriptions, topics, notes, and any future external content must be treated as untrusted inputs.
- Retrieved content must never override product policy.

## 6. Tool Registry

The model should see a very small set of domain tools. Avoid generic write tools.

### Read and Inspection Tools

`list_visible_stars`

- purpose: return the current visible repo scope when the user is working from the current list
- risk: `read_only`

`search_stars`

- purpose: search stars by name, description, language, or tags
- risk: `read_only`

`read_star`

- purpose: inspect one repo in detail
- risk: `read_only`

`list_tags`

- purpose: list known tag names and lightweight metadata
- risk: `read_only`

`inspect_tag`

- purpose: inspect one tag, its attached repos, and key signals like notes/favorite usage
- risk: `read_only`

`get_pending_suggestions`

- purpose: list the most recent pending suggestion sets
- risk: `read_only`

### Proposal-Only Suggestion Tools

`create_topic_tag_suggestions`

- purpose: create a pending suggestion set for untagged repos
- risk: `suggest`
- input:
  - optional `fullNames`
- output:
  - created suggestion set id
  - counts by bucket

`create_low_use_tag_suggestions`

- purpose: create a pending suggestion set for low-use tag cleanup
- risk: `suggest`
- input:
  - `threshold`: enum `1 | 2 | 3`
  - optional `protectedTags`
- output:
  - created suggestion set id
  - counts by bucket

`read_suggestion_set`

- purpose: inspect grouped suggestions, selection state, and summary
- risk: `read_only`

`update_suggestion_selection`

- purpose: update which suggestions are selected
- risk: `write_local`
- side effect scope: suggestion state only, not tag data

### Approval-Gated Commit Tools

`apply_selected_proposals`

- purpose: apply selected proposal IDs to local IndexedDB
- risk: `destructive`
- permission: `approval_required`

`undo_last_suggestion_apply`

- purpose: undo the most recent apply snapshot
- risk: `destructive`
- permission: `approval_required`

Tool design rules:

- strict schemas;
- no unknown fields;
- no general `write_database` capability;
- no direct arbitrary filtering language from the model;
- large result sets should be grouped and paginated before returning.

## 7. Planning Behavior

MVP planning should be light.

The agent does not need a full explicit plan mode for every request, but it should pause and choose an action path when:

- the user request is ambiguous;
- the request could imply deletion or broad tag changes;
- the request mixes several goals.

Example:

```text
User: help me clean up my tags
Agent:
- inspect tag landscape
- identify low-use candidates
- create cleanup suggestions
- ask for review
```

The planning artifact can remain implicit in the conversation UI in MVP. No separate persisted plan object is required yet.

## 8. Goal-Like Loop Behavior

No long-running goals in MVP.

The first version should stay session-bound:

- no background objectives;
- no resumable multi-hour jobs;
- no autonomous retries after the panel closes.

The longest operation should be:

- inspect data;
- create suggestions;
- wait for approval;
- apply once.

This keeps the harness closer to a safe Level 2 actor than a long-running worker.

## 9. Context, Memory, and Auto-Compaction

Durable state should live outside the prompt:

- pending suggestion sets;
- selected suggestion ids;
- latest apply snapshot;
- result summaries;
- timestamps and simple status.

The current Agent implements bounded automatic compaction without making model
memory authoritative. It compacts before a turn and after a complete tool
envelope, preserving the active user/tool suffix verbatim while replacing only
older committed history with a checkpoint summary. Raw client-owned history is
not rewritten.

Practical rule:

- rebuild state from IndexedDB and current suggestion records whenever needed;
- do not rely on the agent remembering prior conversation for correctness.
- derive admission from versioned provider capacity and a reducing-only working cap;
- require an explicit declared window for unknown Custom or automatic-router models;
- keep live tool results as complete structured JSON under dynamic context and memory budgets;
- treat compacted history as untrusted and never as write authorization.

When compaction cannot continue safely, the UI preserves the draft and offers a
typed recovery path: retry, adjust AI settings, or continue in a new
conversation depending on the failure category. Successful compaction remains
low-noise and only reports that older messages were summarized.

## 10. Skills and Connectors

MVP uses no external connectors.

The only connector-like surfaces are internal:

- IndexedDB read/write paths through background handlers;
- existing tag and star query logic;
- existing config access;
- existing `suggestTags` topic logic where helpful.

Future provider integration should attach as a model adapter, not as a direct storage writer.

Future Web Bridge or MCP support can attach later above the same tool registry.

## 11. Prompt Caching and Cost-Aware Context

Current context admission uses a full deterministic estimate and, when a valid
Provider usage block exists, a Provider prefix anchor plus deterministic trailing
messages. The larger projection wins. Cached-input, cache-creation, and reasoning
subsets are normalized without double counting and can never expand the working
window.

Stable prefix:

- agent role;
- hard safety rules;
- tool descriptions;
- product boundaries.

Dynamic suffix:

- current user task;
- current visible repo scope;
- tag summaries;
- selected suggestion set preview.

Do not attach large raw repo lists unless needed. Prefer:

- grouped counts;
- paginated repo slices;
- targeted repo detail fetches.

This keeps token usage bounded without making prompt caching a correctness
dependency. Provider capacity, working cap, output reserve, compaction reserve,
and service-worker byte memory remain distinct concepts.

## 12. Safety and Approval Policy

Non-negotiable safety rules:

- the model never mutates IndexedDB directly;
- every destructive change becomes a suggestion first;
- `apply_selected_proposals` requires explicit user approval;
- `undo_last_suggestion_apply` requires explicit user approval;
- `delete_tag`-like behavior must be validated against current repo attachments before apply.

Permission model:

- read tools: allow
- proposal-only suggestion creation: allow
- selection-state updates: allow
- apply or undo local data writes: approval required

Conflict handling:

- repo-level add/remove actions are tolerant and idempotent;
- tag deletion is strict and blocks if affected repos changed;
- failures must return structured conflict results, never partial silent mutation.

Network side effects:

- no automatic Gist Push after apply;
- no automatic Gist Push after undo.

## 13. Observability and Evals

The current Agent does not persist prompts or a full audit table. It emits local,
content-free diagnostic events with numeric windows, estimates, observed usage
adjustments, tool allowances, limiting factors, and bounded compaction/terminal
categories.

Allowed diagnostic state:

- session and policy identity;
- numeric budgets and usage adjustments;
- compaction trigger, retry, fallback, and terminal category;
- tool-result bytes and whether the harness replaced an oversized result.

Prompts, repository names, notes, code, tool payloads, credentials, headers, and
raw Provider errors are prohibited. Canary tests and strict Port key validation
enforce this allowlist.

Minimal eval and test surface:

### Unit

- low-use cleanup bucketing;
- protected tag handling;
- excluded tag handling;
- topic suggestion existing-vs-new bucketing;
- language not used as tag.

### Integration

- apply add tag;
- apply delete tag writes tombstone;
- delete-tag conflict blocks apply;
- apply is all-or-nothing;
- undo restores repo tags and tag meta;
- undo skips later-mutated rows and reports conflict counts.

### Regression

- Dexie schema upgrade with `agentProposals`;
- empty proposal stores do not break UI/background flows.

### Context v2

- trusted and declared model capacity normalization;
- exact-threshold and Unicode property fixtures across narrow and large windows;
- two near-8KiB tool results with admission-to-preflight proof;
- pre-turn and completed-envelope compaction grammar;
- one summary retry, deterministic fallback, abort, and no-candidate paths;
- typed Port/UI recovery with draft, focus, CAS, and write-uncertainty protection;
- content-free diagnostic and Provider overflow invalidation canaries.

Launch gates:

- stable suggestion generation for both tasks;
- apply/undo verified by integration tests;
- no direct mutation path from model-facing code;
- no broken existing sync/tag flows.
- full unit, integration, regression, runtime, build/package, and diff checks;
- unpacked-Chrome Custom declared-capacity, large-result, compaction, cancellation,
  Provider-switch, and recovery scenarios.

## 14. Minimal Implementation Path

1. Keep the existing plan document path, but evolve it into the agent harness blueprint in this file.
2. Add the IndexedDB store for pending proposal envelopes.
3. Build domain types for proposal envelopes, deltas, evidence, and source snapshots.
4. Build read-only domain tools over existing stars/tags/tagMeta data.
5. Implement proposal-only suggestion generators:
   - topic tag suggestions;
   - low-use tag cleanup suggestions.
6. Implement transaction-based apply and undo in background code.
7. Add a `Cubby` panel UI with a chat-like surface and constrained interaction model.
8. Wire `Auto assign tags` to open `Cubby` instead of silently applying tags.
9. Add tests for suggestion generation, apply, undo, and schema upgrade.
10. Run `pnpm typecheck`, `pnpm test:logic`, `pnpm test:integration`, and `pnpm test:regressions`.

## 15. First Release Checklist

- `Cubby` opens from the toolbar.
- The agent can help with the two MVP tasks:
  - suggest tags for untagged repos.
- Low-use tag cleanup stays implemented behind the typed tool boundary but is not exposed in the chat UI yet.
- The agent only sees narrow typed tools.
- The agent cannot directly write tags.
- Every suggested write must pass through approval and apply.
- Apply runs in one transaction.
- Undo restores the most recent applied suggestion set.
- No automatic remote sync occurs.
- Existing sync, tag editing, and Gist flows still work.
- Relevant tests pass.

## Appendix: Concrete MVP Data Model

The current storage shape uses proposal envelopes, not drafts. Each model-facing
suggest tool can create pending rows, and a future apply path should accept only
selected proposal IDs.

```ts
type ProposalStatus =
  | 'pending'
  | 'applied'
  | 'superseded'
  | 'expired'
  | 'reverted';

type ProposalKind = 'add_repo_tag' | 'remove_repo_tag' | 'delete_tag';

type ProposalDelta =
  | {
      kind: 'add_repo_tag' | 'remove_repo_tag';
      full_name: string;
      tags: string[];
    }
  | {
      kind: 'delete_tag';
      tag: string;
      affectedRepos: string[];
    };

interface ProposalEnvelope {
  id: string;
  sessionId: string;
  status: ProposalStatus;
  kind: ProposalKind;
  delta: ProposalDelta;
  reason: string;
  evidence: ProposalEvidence[];
  sourceSnapshot: ProposalSourceSnapshot;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  appliedAt?: string | null;
  revertedAt?: string | null;
}
```

Dexie store:

```ts
agentProposals: 'id, sessionId, status, kind, createdAt, expiresAt'
```
