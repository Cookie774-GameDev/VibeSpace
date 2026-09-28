# Jarvis voice VI01 checkpoint

2026-09-28 06:15 UTC; branch `integration/UnifiedChungus-final`; base/current HEAD `eee963dabf84884516f3783c7b8a86339ecd5f68`. Root owner: `VS-CODEX-VOICE-IMPL-20260928-VI01`.

## Owned source

- `app/src/features/voice/VoiceModal.tsx`
- `app/src/features/voice/VoiceModal.turn.test.tsx`
- `app/src/features/voice/VoiceModal.sttSmoke.test.tsx`
- `app/src/features/voice/voiceChatRouting.ts`
- `app/src/features/voice/voiceChatRouting.test.ts`
- `app/src/features/voice/voiceTypedAgentFlow.ts`
- `app/src/features/voice/voiceTypedAgentFlow.test.ts`

The voice panel now sends a persisted Main Agent turn and waits for actual runtime acceptance before reporting delivery. Voice-only brevity guidance, selected provider/model, mini-bar parity, scoped conversation binding, duplicate suppression, and stale-open guarding are covered by focused tests. Closing and reopening invalidates an old pending Main acceptance wait so a distinct new-chat turn can start immediately; the old failure cannot paint the new chat. A closed panel also reconciles an orphaned voice session/listening flag without cancelling an already accepted background Main task. `AFTER_CHAT_LOCKS.md` records the pending chat/runtime integration.

## Verification

- `npm --prefix app run test -- --run src/features/voice/VoiceModal.turn.test.tsx src/features/voice/VoiceModal.sttSmoke.test.tsx src/features/voice/voiceChatRouting.test.ts src/features/voice/voiceTypedAgentFlow.test.ts --maxWorkers=1`: 4 files, **64/64 passed**, 18.37 s, exit 0 on the latest source. The strengthened close/reopen test first failed because the second dispatch did not occur, then passed after the generation guard. The new orphaned-session test first failed because the session remained bound; its isolated post-fix assertion passed, but that short isolated process exited 1 from seven Vitest lazy-import `EnvironmentTeardownError` reports. The grouped run exited 0 without those errors.
- Prettier check on the seven owned source paths: pass. `git diff --check` on the same paths: exit 0. A formatting warning was fixed in `VoiceModal.turn.test.tsx` after the test run; it changed layout only.
- `git apply --reverse --check work/voice-agent-flow-20260928-VI01/owned-voice.patch`: pass. Patch SHA256 `1D9351DC0422DFF2C3BD3507A08F1708DB8928522AE9E21067E455AF052DA8D5`.
- No broad typecheck or build result yet. The exact no-output typecheck request `VOICE-TSC-POST-IMPLEMENTATION-20260928-TO01` is **blocked without a grant** in heavy-job queue revision 14: prior RAM/commit numbers were not measured whole-tree peaks, and the provisional RAM admission check observed 2380.40 MiB against 2524 MiB required. No typecheck was launched. In native C1, an active Ambient dialog initially covered the button; one Escape cleared it in 3172 ms. A later normal click did not leave a visible voice panel after an 8 s wait; UI reported `voiceModalOpen=false`, stale `voiceState=listening`, and a bound session while the dedicated input service was actually inactive. Operator cleanup returned UI to idle/session absent at 06:10:57 UTC. No transcript, task, selected TTS, screenshot, or provider worker run was verified. This native run preceded the closed-panel reconciliation fix, which is not yet retested in C1.

## Integration limits

The Main dispatch receipt establishes runtime acceptance, not native worker launch. Current chat/runtime events do not expose a proven persisted user-message ID to assistant-placeholder ID mapping for worker activity. A cross-provider native worker session and screenshot transfer to a native child also remain unproven. The saved Worker New/Resume preference must not be reported as an effective native parent-session selection until the chat adapter provides a receipt. CH34's header remains `ACTIVE`, but its append-only record released source and native scope; exact current claims and user scope still need rechecking before chat/runtime edits.
