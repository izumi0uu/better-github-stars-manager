# AI Provider Plans for Cubby

These plans are neutral `plan-bundle/v1` contracts. They are tracked product
documents and have no dependency on OMX, `.omx`, or a task-management runtime.

## Delivery order

```text
P1 Provider Streaming Kernel
├── P2 Agent Runtime and UI Streaming
├── P3 OpenAI Responses Adapter
└── P4 Anthropic Messages Adapter
          ↓
P5 Provider Registry and Custom Provider UX
          ↓
Release Candidate verification
```

| Plan | Scope | Depends on |
| --- | --- | --- |
| [P1](./p1-provider-streaming-kernel.json) | Provider Core, bounded SSE, final aggregation, Chat Completions streaming | None |
| [P2](./p2-agent-ui-streaming.json) | Background Port, incremental UI, Stop, drafts, scroll follow, accessibility | P1 |
| [P3](./p3-openai-responses-adapter.json) | OpenAI Responses protocol conversion and streaming | P1 |
| [P4](./p4-anthropic-messages-adapter.json) | Anthropic Messages protocol conversion and streaming | P1 |
| [P5](./p5-provider-registry-custom-ux.json) | Service/protocol registry, Options, Custom Provider, credentials and permissions | P1, P3, P4 |

P2, P3, and P4 may be implemented in parallel after P1 if their worktrees do
not share uncommitted edits. Tests belong to each plan; Release Candidate
verification is a final gate, not a sixth feature plan.

Custom Provider is configuration over the Chat Completions or Responses
adapter. It is not a fourth protocol adapter. Arbitrary custom headers are out
of v1 because they would create an additional secret-storage, export, and
redaction surface.

## Pi source-reference requirement

P1, P3, and P4 must follow the
[Pi source reference contract](./pi-source-reference.md). Reviewing the mapped
Pi files and completing the comparison record are required implementation and
acceptance steps. Pi remains a pinned comparison source, not a package
dependency or the authority for provider wire schemas.
