# C1 Native Baseline — 2026-09-28

This is a passive baseline for the VI01 Jarvis voice implementation. It does not claim implementation acceptance.

## Identity and page

- Reattested before and after attaching: official C1 `jarvis.exe` PID 19476 at `D:\VibeSpace-Testing\MI01-cargo-target\debug\jarvis.exe`; WebView PID 26784, profile `ai.jarvis.desktop\EBWebView`; CDP port 9223 owned by PID 26784. Root retains the active V4C1 reservation.
- Selected one official Tauri chat page at `http://localhost:5173/?route=chat`; title `VibeSpace`, document ready, Tauri bridge present.
- Playwright attach plus stable-page readiness took **5,561 ms**. This is not app startup or panel-open timing.
- Binary file/product version: **1.5.0**. Renderer is served by Vite PID 32892 from this worktree's `app` directory. The frontend source identity is not frozen: the shared worktree has root-owned in-progress voice edits and Vite HMR is active.

## Observed voice state and selections

- Voice panel: closed, unmounted, hidden. Voice store: `idle`, no error flag, no session.
- Main Agent: Codex. Worker: Codex, new session.
- STT selection: `system`; no Deepgram model override is stored. The faster-whisper selection is `whisper-small-en-q8` but is not the selected STT provider.
- TTS selection: Jarvis (`jarvis`) / `jarvis-prime`. `speakReplies` is false. Hands-free-on-open is true.
- Microphone permission query returned `granted`; `mediaDevices.getUserMedia`, SpeechRecognition, speechSynthesis, and WAV audio-element support APIs are present. The browser reports 3 installed speech voices.

## Safety and limits

I did not open the panel during this passive baseline because the saved hands-free-on-open setting is enabled. I did not request microphone capture, play audio, inspect transcripts/drafts, click controls, or take a screenshot. Therefore panel-open latency, real STT, and real selected Jarvis TTS output remain unverified. The API probes do not prove actual audio capture or playback.

The first driver launch stopped before CDP attach because the harness could not infer `LOCALAPPDATA` in the spawned Node environment (`local_app_data_unavailable`). The C1-pinned driver now passes the explicit official profile base and reattested successfully; this was a harness setup issue, not an app failure.

## Driver and machine-readable receipt

- Parameterized, fail-closed driver: [c1-baseline.mjs](./c1-baseline.mjs)
- Sanitized receipt: [c1-baseline.json](./c1-baseline.json)
- `node --check work/voice-agent-flow-20260927-VF01/qa/voice-impl-20260928/c1-baseline.mjs` passed.
- Persistent attached driver is exec session 47531. Commands supported: `snapshot` (read-only refresh) and `quit` (ends this Node driver without closing the app).