# Native C2 verification — 2026-09-25

- Running instance 2: CDP `9252`, existing compiled Tauri binary, profile `work/dual-live-20260912/profile-c2`; no rebuild. Instance 1 was untouched.
- C2 selected STT provider `faster-whisper`, model `whisper-base-en-q5`; native `faster_whisper_check_installed` reported installed and `faster_whisper_status` reported ready. The dictation worker transcribed a local WAV to “Testing Local Vibe Space Dictation This is a free offline transcription check.” in 4.16 s.
- C2 mini dictation panel visibility: hidden → shown; themed right-click Close visible; clicking it returned hidden. Browser WebSpeech's `system` engine still depends on a remote recognition service and returned `network` in this WebView. The offline Local option is the working free selection.
- Two native C2 OpenCode terminals used `GPT-6 Luna` through OpenAI OAuth. A generated `PEER-A-READY-X26`. Fabric's original raw transcript relay produced a corrupted prompt at B, which was fixed to send a completed reply or an explicit message. The clean relay reached B and B generated `PEER-A-ACK-X26 — received.`; a return Fabric relay reached A and A generated `PEER-B-ACK-X26`.
- Native terminal snapshots yielded the clean latest replies for both peers. C2 reload restored both terminals and their conversations; the bridge can reconnect to the same sessions. Screenshots and Playwright probes remain in this work folder.
- App typecheck passed; focused tests: 4 files, 44 tests passed. `git diff --check` passed on claimed product files.
- The Rust fallback model manifest now names the real upstream `vocabulary.txt`. This source-only fallback correction was not rebuilt, per the instance 2 constraint; the running C2 binary used the verified frontend manifest and compatibility conversion.
