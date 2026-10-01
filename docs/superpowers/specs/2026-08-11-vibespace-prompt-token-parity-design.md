# Prompt Forge and Token Optimizer OpenCode Parity Design

## Objective

Prove PR31 Sections 21–22 without changing their product semantics:

- Prompt Forge keeps its exact source pack, secret gate, selected connection
  and model, system prompt, preservation validation, cancellation, streaming,
  and mismatch rejection while `runAgent` transports it through OpenCode.
- Token Saver, Normal, and Token Final Boss keep VibeSpace preprocessing,
  protected segments, receipts, output limits, and reasoning policies before
  the exact compiled request enters OpenCode.

## Prompt Forge authority

Prompt Forge already calls the shared `runAgent` entry point with
`purpose: 'prompt_forge'`; PR31 therefore transports it through OpenCode.
However, an empty `agent.tools_allowed` array is metadata and does not itself
disable generated OpenCode tools. Prompt Forge must pass an explicit
fail-closed tool policy containing every semantic Tool Gateway capability set
to `false`. Built-in OpenCode edit/bash/task authority remains denied by the
private harness configuration.

The existing Prompt Forge system prompt and preservation rules remain
unchanged. The post-response provider/model comparison remains the second
identity check after OpenCode usage events.

## Token mode authority

VibeSpace remains the pre-send optimizer. Its mode bridge maps:

- Saver → Token Saver reasoning and bounded output;
- Normal → provider-default reasoning;
- Final Boss → highest appropriate verified effort and bounded verification.

The optimizer preserves protected content, produces its existing receipt, and
never changes provider/model. The runtime appends only the selected mode’s
execution contract, then calls the same OpenCode-only `runAgent` path with the
exact selection. OpenCode session compaction remains reactive to actual context
pressure and does not replace VibeSpace optimization.

## Verification

Prompt Forge tests must assert the complete 26-entry deny policy reaches
`runAgent`, and adapter tests must prove it reaches the OpenCode prompt.
A three-mode parity test combines the real mode resolver with the real OpenCode
adapter to prove exact system instructions, model identity, and one harness
dispatch per mode. Existing optimizer/runtime suites remain the authority for
protected content, receipts, overflow, cancellation, and telemetry.
