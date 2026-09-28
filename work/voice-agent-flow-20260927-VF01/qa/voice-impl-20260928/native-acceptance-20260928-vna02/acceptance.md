# VNA02 C2 post-fix native retest

**Status: BLOCKED before page evaluation.** This run did not verify the voice panel lifecycle or microphone state.

## Identity

- Official C2 `jarvis.exe`: PID 17280, `work/dual-live-20260912/target-c2/debug/jarvis.exe`, SHA256 `F249F39AEE9F550D5D10AC1564526DBF250DAB5988F22A5E2B8D9113B563EF13`.
- Child WebView: PID 12248, profile `work/dual-live-20260912/profile-c2/EBWebView`, CDP 9252 owned by PID 12248.
- Repo Vite renderer: PID 32892, port 5173. The three relevant voice files were clean at HEAD `cdb310dd5a17530dcbe8c85a4bf73e265e0de092`; hashes and the 06:57:30Z post-attempt attestation are in [identity.json](identity.json).
- C2 process, profile, listeners, Vite identity, branch, and source hashes still matched after the failed attach.

## Attach attempts

1. The shared native harness exited 1 in 5.587 seconds at its pre-attach safety check: `forbidden_ollama_or_11434`. A read-only check found `ollama.exe` PID 15196 at `D:\VibeSpace-Ollama-X22\bin\ollama.exe`, owning `127.0.0.1:11434`. No action was taken on that process or listener. Root classified that zero-Ollama gate as PR31-specific and authorized a narrow direct C2 Playwright attempt without editing the shared harness.
2. Direct Playwright Core 1.61.1 `connectOverCDP` exited 1 in 3.407 seconds before page selection. WebView exposed an attached `shared_worker` target with a `blob:http://localhost:5173/...` URL and `pid: 0`; Playwright asserted while processing the target because its `browserContextId` was absent. The read-only `/json/list` inventory contained two official-title page targets (`dictation` and `chat`) with WebSocket endpoints. It did not establish a supported, clean page-scoped Playwright attachment. Per the bounded test instruction, no retry or shared-worker change was attempted.

## Actions and limits

- No UI click, ambient wake key, mic start, stop, close, settings change, transcript/draft read, screenshot, build, reload, app restart, or C1 interaction occurred.
- The test script made no request to port 11434; the unrelated Ollama process and listener remain running.
- The page was not selected or evaluated, so initial/current voice stores and actual mic state are unknown. The test did not start microphone capture.
- STT, TTS, provider identity, worker launch/result, screenshot flow, and closed-state reconciliation remain unverified.
- GC23 released the VNA02 C2 reservation at 2026-09-28T07:00:23.137Z (SP03 queue revision 19; results revision 8). C1 was untouched.

Structured details and exact errors are in [acceptance.json](acceptance.json). Native identity evidence is in [identity.json](identity.json).
