# OpenCode Child-Session Product Parity Design

## Objective

Preserve VibeSpace's existing `/multitask` and `/subagents` product:

- VibeSpace still owns task decomposition, child chats, agent cards,
  approvals, supervision, and status presentation.
- Every child chat still uses the selected VibeSpace model and the shared
  OpenCode-only `runAgent` path.
- Each child chat's OpenCode session is created with the parent chat's
  OpenCode session as `parentID`.

## Session binding

The OpenCode adapter owns the chat-scope-to-session map, so it is the only
layer that can safely translate a VibeSpace `parentChatId` into an OpenCode
`parentSessionId`.

The runtime passes the structured multitask/subagents parent chat ID through
the router as bounded metadata. Before creating a child session, the adapter:

1. validates the parent scope;
2. rejects a self-parent relationship;
3. reuses the parent's mapped OpenCode session, or creates a dormant parent
   session when the parent has not sent a model turn yet;
4. creates the child with that exact parent session ID and the same working
   directory.

A later parent turn reuses the dormant session and sends its complete pending
history. No provider/model selection is inherited from OpenCode: the child
continues to use VibeSpace's explicit model-selection override.

## UI status binding

After the adapter resolves a session, it reports a normalized session binding
to the runtime. The existing structured-agent status path records the child
and parent OpenCode session IDs on the existing VibeSpace agent card while
retaining its current thinking/done/failed/cancelled transitions.

The IDs are opaque non-secret correlation values. OpenCode response shapes do
not enter UI components.

## Failure and lifecycle rules

- Invalid, ambiguous, self-parented, or working-directory-mismatched
  relationships fail closed before prompting.
- Session replacement preserves the same parent binding.
- Capacity eviction must not evict the parent while its child is being
  created.
- Adapter clear/delete behavior remains bounded and owns all sessions it
  created, including dormant parents.
- VibeSpace remains the outer permission authority.

## Verification

Tests cover parent-before-child and child-before-parent ordering, exact
`parentSessionId`, model preservation through the router, normalized runtime
card binding, completion/failure status behavior, harness `parentID`
serialization, session reuse/replacement, and invalid relationship rejection.
