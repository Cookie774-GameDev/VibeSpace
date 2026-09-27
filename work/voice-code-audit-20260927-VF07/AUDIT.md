# Jarvis voice code audit, VF07

Branch `integration/UnifiedChungus-final`; base HEAD `bb26002657d8730a7f9641333bf24a921cf4e603`. This audit did not operate any native app or browser.

## Settings and route inspection

- Voice defaults in `auth.ts`: Main Agent Codex, worker Codex, resume provider chat, typed mini bar off, Jarvis High voice (`jarvis` engine and `jarvis-prime` preset), hands-free on, phrase completion (`send it`), and Free System STT. These choices are persisted independently.
- Voice settings expose Main Agent and worker providers, resume/new chat, mini bar, Jarvis/Friday personas, speech engine, and hands-free phrase/silence modes. Speech to Text settings expose Free System, Local Whisper, and Deepgram Nova-3/Flux options. The selected STT route is shared by composer dictation and Jarvis voice.
- The selected STT service routes Free System through Web Speech with an installed-local-Whisper fallback on network failure, Local through the selected installed Whisper model, and Deepgram through the saved Nova-3/Flux model with a required key. The selected TTS engine routes Jarvis High/Friday, system/local speech, or Deepgram through the existing voice router; unavailable cloud TTS can fall back through the existing TTS service.

## Repair found during audit

Local Whisper was a batch recorder. In hands-free Jarvis voice, it had no spoken way to stop and transcribe, so the selected Local option could remain recording indefinitely. `dictationSession.ts` now finishes this requester’s batch after speech energy drops for 1.2 seconds, emits one final transcript and a voice-only completion signal, and clears its timer on stop/cancel. Other dictation requesters keep manual stop. The focused test failed before this change and passed afterward.

The Speech to Text settings falsely said they did not affect Jarvis voice. Their description now matches the shared selected route and the installed-Whisper fallback. Voice settings now describe phrase and pause modes according to the actual selection.

Changed product/test files: `app/src/features/global-dictation/dictationSession.ts`, `dictationSession.test.ts`, `app/src/features/settings/sections/ComposerStt.tsx`, `Voice.tsx`, and `Voice.agentProviders.test.tsx`.

## Code checks and limits

- The focused 12-file STT/TTS/settings suite passed 142/142 tests. A separate settings regression passed 2/2 tests, covering default resume and mini bar off plus independent saving. Prettier and scoped diff checks passed.
- TypeScript `npx tsc --noEmit --incremental false` passed. An isolated production Vite bundle passed in 1 minute 24 seconds under this task's `isolated-dist/` directory; its bundled Jarvis acknowledgment WAV matches the source SHA256. The normal `app/dist` and Cargo caches are owned by another active agent, so this audit did not write either area.
- The release-manifest suite passed 45/45 tests. These checks validate package/artifact metadata, not native microphone or speaker behavior.
- Real microphone capture, Web Speech availability, Whisper model installation, Deepgram credentials/service, and audible TTS require a later official native WebView run. Unit tests and build checks cannot establish those live outcomes.
- The default hands-free completion remains phrase based: users say `send it`, or select Pause (silence). This audit preserved that existing choice.

## Self-improvement note

Settings text must be checked against the service that actually reads the saved value. Here the Speech to Text screen excluded Jarvis in its copy even though Jarvis calls the shared selected STT service. The shared `.learnings/` files are peer-owned, so this task records the correction here.
