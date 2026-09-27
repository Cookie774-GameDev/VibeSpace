# Jarvis voice startup and input, VF06

Agent `VS-CODEX-VOICE-STARTUP-20260927-VF06`; task `JARVIS-VOICE-STARTUP-20260927-VF06`; branch `integration/UnifiedChungus-final`; base `a52e24b550d16ed810c5b196979c3b5276f083c9`.

## Changed files and reasons

| File | Change and reason |
| --- | --- |
| `app/src/App.tsx` | Load the existing VoiceModal with the app shell so opening it does not await a module fetch. |
| `app/src/stores/auth.ts` | Persist independent resume/new-chat and typed-mini-bar settings; defaults are resume and off. |
| `app/src/features/settings/sections/Voice.tsx` | Expose those two options in one voice settings area. |
| `app/src/features/voice/VoiceModal.tsx` | Respect the resume/new-chat setting, show the optional translucent text form, route typed text through the existing voice turn, and submit a completed local STT fallback transcript once. |
| `app/src/features/voice/VoiceModal.turn.test.tsx` | Cover settings, typed turn, completed fallback submission, and duplicate completion signals. |
| `app/src/features/global-dictation/dictationSession.ts` | Let Jarvis voice finish an installed Whisper fallback after 1.2 seconds of quiet; publish its final transcript and a completed-turn signal. Other dictation requesters keep their behavior. |
| `app/src/features/global-dictation/dictationSession.test.ts` | Cover local fallback finalization and history status. |
| `app/src/features/global-dictation/deepgramDictation.ts` | Type the optional completed-turn signal; no provider behavior change. |
| `app/src/features/voice/VoiceService.ts` | Type the existing voice turn-end event for that signal. |
| `app/src/features/voice/JarvisVoiceInputService.ts` | Forward the completed-turn signal to the existing voice panel. |
| `app/src/features/voice/JarvisVoiceInputService.test.ts` | Verify the signal crosses the selected STT adapter. |
| `app/src/features/voice/voiceRouter.ts` | Play a bundled, pre-rendered “On it.” through the existing TTS router for the selected Jarvis High voice, with normal TTS fallback if playback fails. |
| `app/src/features/voice/voiceRouter.test.ts` | Check actual play, cancellation, and failed-playback fallback. |
| `app/public/voice/jarvis-on-it.wav` | Native-rendered 0.569-second acknowledgment for Jarvis High; 25,132 bytes. |
| `docs/superpowers/specs/2026-09-27-jarvis-voice-startup.md` | Design and acceptance scope written before production edits. |

## Evidence and limits

- Focused voice/STT tests: 4 files, 89 tests passed. Voice settings tests: 2 files, 12 tests passed. TypeScript `npx tsc --noEmit --incremental false` passed. Release-manifest: 45 passed. Scoped `git diff --check` and Prettier checks passed.
- Isolated production Vite bundle passed in 1 minute 8 seconds under this task's `isolated-dist/` output. The output contains `voice/jarvis-on-it.wav` with the same SHA256 as the source: `6726447FEDBB74F2D11082068FC98744E0206AF3849DE2B591042C8D2923FA22`. The normal `app/dist` build and Cargo cache are claimed by another active agent, so this run did not write either area. No Rust source changed here.
- Earlier official Instance 2 Playwright evidence, before the user's live-test pause: `jarvis.exe` PID 32968, WebView PID 5500, profile `work/dual-live-20260912/profile-c2/EBWebView`, CDP 9252. Panel attach measured about 3.95 seconds before the static import, 35 milliseconds on first click and 34 milliseconds on reopen after it. Settings showed resume/off defaults; new mode produced distinct chats and resume reused its chat. Scripts are in this task directory.
- An earlier native typed turn reached `jarvis:send`, and a later speech blob played. The first audio event was only the UI click sound; it did **not** prove a fast spoken acknowledgment. This prompted the bundled acknowledgment. Actual speech latency after the new asset and final spoken result remain unverified.
- User paused all further live app testing. Real microphone STT, installed-Whisper fallback, selected TTS playback, mini-bar visual quality, and full end-to-end result must be checked in the assigned official Tauri WebView when that pause is lifted. The Free System STT fallback requires an already-installed Whisper model; if none exists, it still reports a real network/unavailable error.
- Main Agent versus worker delegation changes, including answering simple date questions without a worker, are deferred under the user's pause on subagent work. No shared chat or SkillMD files were edited.

## Self-improvement note

Do not count the first audio playback as a spoken acknowledgment: the voice open button has its own sound. Match the audio source or speech event to the acknowledgment, and report native speech separately from UI click timing. The shared `.learnings/` files are peer-owned, so this task records the lesson here.
