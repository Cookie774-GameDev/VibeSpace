# Voice Turn-Taking and Microphone Test Design

## Scope

Finish Prompt 15 without changing the established Jarvis High, Deepgram, billing, or model-selection systems.

## Design

- Keep `Hey, Jarvis` detection and the exact `Ready.` acknowledgement unchanged.
- Treat voice submission as two modes: explicit phrase submission and pause submission.
- Explicit phrase submission has no inactivity timeout. It accumulates finalized speech until `send it` is heard.
- Pause submission uses one persisted silence duration for both its UI and runtime behavior. The supported range is 1–60 seconds.
- Keep the existing voice/chat auto-run settings and Shift+Tab binding, but verify them with focused tests.
- Replace the permission-only microphone check with a bounded local capture test. It enumerates input devices, exposes permission state, reports a live level, records a short clip for local playback, distinguishes silence and excessive background noise, and always releases tracks/audio resources.

## Boundaries

No cloud transcription, dependency, wake-word redesign, voice-engine change, provider credential change, or unrelated Settings change.
