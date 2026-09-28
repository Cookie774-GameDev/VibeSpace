# Official C1 Native Acceptance — VNA01

**Result:** blocked; native voice flow not accepted. The app opened, the ambient screen woke, and the top-bar voice button became actionable. One normal click did not reveal the voice panel. I stopped at that boundary and performed safety cleanup; I did not claim STT, spoken acknowledgment, TTS, or a worker launch.

## Identity

- Official C1 only: `jarvis.exe` PID 19476, SHA-256 `639EF6C283166EE12AAE2AF084BF6B132B034ED2E53F24426E91AA643E2C7879`.
- Tauri WebView PID 26784, child of 19476, official `ai.jarvis.desktop/EBWebView` profile; CDP 9223 listener owned by 26784.
- Edge WebView 153.0.4234.48, app 1.5.0, Tauri bridge present, branch `integration/UnifiedChungus-final`, HEAD `eee963dabf84884516f3783c7b8a86339ecd5f68`.
- Identity was reattested immediately before each reattach. C2 was not touched. The renderer bundle itself was not independently hashed.

## Bounded interaction

At baseline (06:03:19.483Z), voice was closed and idle. Saved settings were Main Codex, Worker Codex/New, STT System, TTS Jarvis Prime, speak replies off, hands-free on open. Microphone permission was granted; browser STT/TTS APIs were present.

A prior read-only hit test found the voice icon covered by the intentional full-screen ambient dialog (“Press any key to wake”), z-index 70. After one Escape key, the overlay became inactive in 3,172 ms. The normal voice button was then actionable at (52, 19.6), and its center hit its own SVG child. One ordinary click was sent. The panel did not become visible within the 8-second wait; the 06:03:53.834Z snapshot showed `voiceModalOpen=false`, hidden panel, but the voice store still said `listening` with a session. A later normal recovery lookup found no Start Jarvis voice button (count 0).

For cleanup, the app’s own UI store was set closed, then `JarvisVoiceInputService.cancelListening()` and `voiceRouter.handleVoiceModuleClosed()` ran in the attested WebView. The selected input service reported inactive and not-wanted both before and after; the final UI snapshot was closed/idle, no session/error, status Ready. The minimized snapshot did not directly include the separate `voiceListening` boolean; the called close handler sets it false. This establishes the UI store had stale Listening/session state; it does not establish that microphone capture had been active. No transcript was read, no worker task was sent, no settings changed, and no screenshot was taken. The driver disconnected; the app window remained open.

## Verification and limits

`node --check work/voice-agent-flow-20260927-VF01/qa/voice-impl-20260928/native-acceptance-20260928/native-voice-driver.mjs` passed (exit 0). No build or reload was run. Ambient wake and post-wake button actionability passed; voice panel open failed. Actual transcription, acknowledgment, TTS, worker receipt, provider override, screenshot behavior, and duplicate suppression remain untested in native C1.

Structured event data is in `acceptance.json`; native identity is in `identity.json`. The parameterized Playwright driver is `native-voice-driver.mjs`.
