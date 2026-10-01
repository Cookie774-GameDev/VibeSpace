# PR31 Phase 9: OpenCode Ollama Bridge

## Goal

Make locally installed Ollama models available to the private OpenCode server
without treating the curated download catalog as an availability allowlist.
Classify discovered models for agent use with a digest-keyed cache.

## Constraints

- Keep the existing ten-entry curated catalog and all of its metadata.
- Add every valid model returned by the loopback Ollama daemon to OpenCode.
- Omit the Ollama provider when the daemon is missing or no models are installed.
- Keep Model Foundry runtimes separate unless they are actually served by Ollama.
- Never pull or download a model automatically.
- Never route local private context to a non-loopback endpoint.
- Preserve exact-selection/no-fallback and offline-only behavior.

## Implementation

1. Add a bounded native Ollama discovery seam for OpenCode server startup.
2. Generate the official OpenAI-compatible `ollama` provider with `/v1`,
   dynamic installed model IDs, and no credentials.
3. Extend model discovery with digest and capability metadata.
4. Add a capability classifier and persistent digest-keyed cache with the
   statuses `agent_ready`, `chat_only`, `unsupported`, and `unknown`.
5. Probe tool calling only when metadata is insufficient and never mutate the
   workspace during a probe.
6. Surface compatibility and reasons in Local Models while retaining all
   discovered names.
7. Verify curated IDs, unlisted installed IDs, missing Ollama, removed selected
   model, offline mode, and representative Llama/Qwen/GPT-OSS fixtures.

## Verification

- Focused Rust harness and Ollama tests.
- Focused TypeScript compatibility, provider reconciliation, and Local Models tests.
- App TypeScript typecheck and scoped formatting.
- `cargo fmt --check` and `cargo check --no-default-features --lib`.
- Read-only actual Ollama version/list smoke when the executable/daemon exists.
