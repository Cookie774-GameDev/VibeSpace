# Voice Main route and effort binding

## Evidence and intent

The A4R3 official C1 run completed a disposable voice turn. Its durable run row matches the test chat and records `openai-codex/gpt-6-luna`; an unrelated bounded Dev Log entry led to an incorrect initial OpenCode diagnosis. The visible Low preference was saved for the fresh chat, but A4R3 did not capture the effective provider effort. A4R4 will bind the per-chat reasoning preference to the same voice send detail that already carries the selected model and connection, and verify the effective effort when the native Codex catalog is available.

## Contract

- When a voice turn has a bound chat, snapshot that chat's reasoning preference alongside its resolved provider/model selection before asynchronous persistence and screen capture.
- Carry the preference through `VoiceAgentRequest` into `SendDetail.reasoningPreference`. The runtime already gives this explicit field precedence over a later local-storage read.
- Preserve the exact Codex or OpenCode route in `modelSelectionOverride`. Do not synthesize a route or substitute a provider if the selected one is unavailable.
- Keep a voice turn's effort stable if the chat preference changes while the turn is being prepared. A later turn reads the new preference.
- Do not change the voice UI, microphone, TTS, worker routing, notification settings, or production services.

## Acceptance

Focused tests first fail on missing effort capture, then pass for the builder and VoiceModal send. Existing voice tests stay green. In official C1, one disposable GPT-6 Luna Low turn must show the exact send selection and Low preference, persisted Codex model, effective Low in runtime or saved usage, terminal answer/speech, and complete cleanup. If the live Codex model catalog remains empty, native effort is unverified and the turn must not be sent through an unverified substitute.
