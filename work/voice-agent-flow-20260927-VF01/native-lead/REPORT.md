# Jarvis voice flow: official Instance 2 native acceptance

Agent/task: `VS-CODEX-VOICE-NATIVE-20260927-VF03` / `JARVIS-VOICE-NATIVE-ACCEPTANCE-20260927-VF03`.

## Target identity

- Official Tauri `jarvis.exe` PID 37352 at `work/dual-live-20260912/target-c2/debug/jarvis.exe`, SHA-256 `F249F39AEE9F550D5D10AC1564526DBF250DAB5988F22A5E2B8D9113B563EF13`.
- WebView2 PID 37040 is a child of PID 37352, uses `work/dual-live-20260912/profile-c2/EBWebView`, and owns CDP listener `127.0.0.1:9252`.
- CDP main page is the official Tauri WebView at `http://localhost:5173/?route=chat`, title `VibeSpace`, with `window.__TAURI_INTERNALS__` present. The served `VoiceModal.tsx` module contains the current `waitForVoiceWorkerReceipt` gate and short acknowledgment text.
- Product voice source did not differ from commit `0ebb5cbe867956f14fed51235aa1942e26d3481a` when HEAD advanced to `d51ee7b009bfce63c84af46f30b6640f6b165302` during native QA. The C2 target and peer C1 processes were not rebuilt or stopped.

## Observed results

| Scenario | Native result | Evidence |
| --- | --- | --- |
| Independent provider settings | PASS: Codex/Codex, OpenCode/Codex, OpenCode/OpenCode, Codex/OpenCode all displayed correctly. Changing either control left the other unchanged. Codex/OpenCode persisted after reopening Settings. Original Codex/Codex restored. | `settings-result.json` |
| Existing voice capture path | PARTIAL: C2 microphone permission was granted. Free System STT reported its recognition network service could not be reached. The existing ready `Whisper base.en Q5` local route reached `listening`, but synthetic Windows speech played through the machine speakers did not yield a committed transcript; no worker task was sent. Original Free System STT was restored. This does not prove a defect in local STT or physical mic capture. | `local-voice-result.json`, `voice-surface.cjs`, `permission.cjs` |
| One-request OpenCode override | PARTIAL: The native Composer parsed the override, dispatched one child agent task tagged `opencode`, and left saved Main/Worker defaults Codex/Codex. No `harnessSessionId` receipt appeared. The child ended `failed` with `Interrupted by app restart.` The native toast truthfully reported that an OpenCode worker session was created but provider receipt was not confirmed. No actual OpenCode receipt/result is claimed. | `typed-override-result.json`, `native-card-diagnosis.cjs` |
| Codex worker route | PARTIAL: One distinct typed Codex request left one child card with model label `Codex · Codex Auto Review`; post-reload card status was `failed`, error `Interrupted by app restart.`, and no harness session was bound. The in-page event recorder was erased by the reload, so it is not evidence of a provider dispatch/receipt. Only the exact unsent VF03 test draft was cleared; the child card was preserved. | `typed-codex-result.json`, `native-codex-post.cjs`, `native-cleanup.cjs` |
| Voice-only brief instruction | Code/focused-test verified; a live Codex/OpenCode Main Agent request receipt is still UNVERIFIED because no worker result was delivered. | Source `voiceAgentFlow.ts`, focused 115/115 result from VF02; native `typed-override-result.json` records no voice instruction on the typed worker event. |
| Screenshot success/failure and worker attachment | UNVERIFIED in C2; no screen image was captured or logged. | Focused unit coverage only. |
| Duplicate transcript, spoken acknowledgment/result, selected TTS voice and timing | UNVERIFIED in C2 because no spoken request committed and no worker result arrived. No latency number is inferred. | `local-voice-result.json` |

## Source verification carried into this run

- Committed voice source: `0ebb5cbe867956f14fed51235aa1942e26d3481a`; coordinator confirmed GitHub `UnifiedChungus` reached the same SHA before this run.
- Focused voice integration: 14 files, 115 tests passed; `npm run typecheck` exit 0; Prettier check on seven VF02 files exit 0; scoped `git diff --check` exit 0.
- Full app suite for this follow-up has no aggregate pass. Production build after VF02 is deferred while peer AP31 owns `app/dist/**`; prior source batch build, release manifest, and Cargo check passed before VF02. These older gates are not a claim that the current follow-up passed them.

## Limits and next acceptance event

Native completion needs a stable C2 WebView long enough to receive a real Codex and OpenCode worker harness binding, an STT transcript or other explicitly labeled injection, one screenshot success and failure to a worker, and observable acknowledgment/final TTS output timing. Both provider attempts ended with child cards marked `Interrupted by app restart.` During the run, peer changes advanced HEAD from `0ebb5cbe` to `d51ee7b0`; the voice source stayed identical. The `jarvis.exe` PID stayed 37352, so the persisted card error documents a WebView/app reload, not evidence that the executable process restarted. No latency number for acknowledgment, worker receipt, or final speech is available. The OpenCode child dispatch-to-failure notice interval measured from one page clock was 90,040 ms; it is a failure timeout, not launch latency. Team `TEAM_LOG.md` and `.learnings/LEARNINGS.md` remain under other active locks; no write was made there. This report and the native QA scripts/results are owned only under `native-lead/**`.
