# BGSM Interaction Design

## Agent Streaming Contract

The Agent drawer presents provider output incrementally while keeping the
validated final response as the only source of conversation history.

### Delivery

- The background owns the active run, abort signal, and terminal result.
- Every background Port delivery has the turn `sessionId`, `baseRevision`, and
  an exact-next nonnegative `sequence` number.
- Duplicate and stale deliveries do not mutate the active turn. A sequence gap
  fails closed instead of skipping content.
- Port deltas contain only displayable assistant text and tool lifecycle state.
  They never contain reasoning, refusal text, usage, credentials, or tool
  arguments.

### Transcript

- Streaming assistant text is transient presentation state.
- A validated final result atomically replaces the transient assistant bubble
  and optimistic user message with committed session messages.
- Abort, provider failure, protocol failure, and transport failure remove all
  partial assistant output from the transcript and restore the submitted prompt
  to the composer.
- Compaction and OrganizeJob remain final-response consumers and do not receive chat
  presentation deltas.

### Stop And Writes

- Stop sends an identity-bound abort command and keeps the Port open until the
  background returns an authoritative terminal result.
- A disconnect remains an abort fallback, not proof that a write did not commit.
- Once a write tool starts, the UI disables one-click retry for an interrupted
  turn. The final result may still trigger a local data refresh when a write
  completed during the stop race.

### Presentation And Accessibility

- Streaming text renders as plain pre-wrapped text. Markdown rendering starts
  only after final validation.
- Tool activity exposes queued, running, completed, and failed states without
  exposing arguments.
- Polite live regions announce phase and tool-state changes, not every text
  delta.
- Conversation scrolling follows new content only while the user remains near
  the bottom. Scrolling upward reveals an explicit Jump to latest control.
- Scrolling respects reduced-motion preferences, and the drawer remains usable
  at narrow extension widths inside the content-script ShadowRoot.
