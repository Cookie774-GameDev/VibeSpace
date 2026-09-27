# Jarvis voice to agent flow

## Scope

Use the existing voice modal, STT selection, chat worker launcher, runtime, and TTS router. A committed voice turn starts one worker child chat, then the protected Jarvis chat presents the worker result through the chosen Main Agent provider and selected voice. The Voice settings section owns two independent persisted provider choices, both defaulting to Codex. Explicit one-turn overrides never save a default unless the user asks to save it.

## Flow and boundaries

1. Commit the existing Nova-3, Flux, or local/system transcript only after the voice turn gate. Normalize a request key and reject repeated final transcripts for the same active or recent request.
2. Stop microphone capture, give a short acknowledgment using the existing TTS router, and resolve the Main and Worker provider selections independently. Reject an unavailable selected provider rather than silently switching providers.
3. When the user says “on my screen,” request one user-permitted display capture. Attach its one bounded image to the child worker message. On failure, send the original text and briefly report that no image was attached.
4. Launch exactly one existing `launchJarvisChatAgent` child session with the user's task, bounded context, actual Worker model selection, and optional image. Report launch only after the launcher returns a child identity. Observe its terminal state and read its persisted final message; never infer completion from a queued card.
5. Send the outcome to the existing protected Jarvis runtime using the selected Main Agent provider for a brief final answer, with voice-only concise instructions added to the effective system context. Keep existing safety/tool instructions. The existing runtime TTS path speaks that answer through the saved voice.

The status surface identifies the actual provider and states capture failure, launch failure, blocked work, and incomplete verification truthfully. Closing the voice session cancels local waiting and prevents stale speech. Native app testing is paused by the user's latest instruction; code checks do not count as native acceptance.
