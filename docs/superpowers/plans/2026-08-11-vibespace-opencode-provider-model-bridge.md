# VibeSpace OpenCode Provider and Model Bridge

**Phase:** PR31 Phase 6
**Starting HEAD:** `d9e51480`

## Outcome

VibeSpace remains the product catalog and picker authority, while OpenCode's
authenticated `/config/providers` response becomes the runtime-availability
authority. A selected VibeSpace identity either resolves to one exact
OpenCode `providerID`/`modelID` pair or fails explicitly. No default provider,
first model, mock provider, or hidden fallback is permitted.

## Runtime parsing

The bridge converts the current OpenCode provider schema into bounded
`HarnessProvider` values. It keeps only UI-safe identity and capability
metadata and discards provider keys, environment names, options, headers, and
other raw configuration.

- At most 256 providers.
- At most 4,096 models per provider.
- Bounded provider, model, and display names.
- Exact case-sensitive IDs.
- Context, attachment/image, and tool-call capability metadata when valid.
- Malformed entries are ignored, never guessed.

## Reconciliation

Catalog providers and models retain their names, order, and product metadata.
Runtime-only models are appended so dynamic OpenCode, Ollama, Qwen gateway,
and custom-provider models remain discoverable. Catalog entries absent from
OpenCode remain visible but explicitly unavailable.

Aliases are deliberately narrow:

- VibeSpace `local` resolves only to OpenCode `ollama`.
- VibeSpace `bedrock` resolves only to OpenCode `amazon-bedrock`.
- The `google-vertex` connection resolves only to OpenCode `google-vertex`.
- An explicitly configured runtime provider ID is used exactly.
- All other providers resolve only by exact provider ID.

The model ID is never aliased. This preserves gateway-qualified identities
such as `qwen/...` on OpenRouter and exact installed Ollama tags.

## Send boundary

Before a Phase 5 harness send opens its stream, it refreshes the OpenCode
provider snapshot and resolves the requested selection. Only the resolved
identity enters `prompt_async`. Missing providers and models produce existing
typed `PROVIDER_NOT_CONFIGURED` and `MODEL_NOT_AVAILABLE` errors before any
prompt is submitted.

This phase does not switch the existing production AI router.

## Verification

Fixture tests cover every provider family required by the master goal,
including Google Vertex, Z.AI, Azure, Bedrock, local/Ollama, Qwen direct,
Qwen-through-OpenRouter, and custom providers. Additional tests cover dynamic
model append, metadata preservation, malformed bounds, secret-field omission,
no fallback, and the exact selection sent by `OpenCodeHarness`.
