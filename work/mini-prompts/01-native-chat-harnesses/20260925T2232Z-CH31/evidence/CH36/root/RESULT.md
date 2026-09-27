# CH36 question answer and plan visibility

Status: code implemented; native acceptance blocked by the active user chat. Prompt 01 remains incomplete.

Changes:
- `app/src/lib/ai/openCodeQuestionReply.ts`: for a single-choice question, a nonempty allowed custom answer overrides the retained selected option. Invalid multiple selections and disallowed custom text still fail closed; multi-select output and original-session authority remain unchanged.
- `app/src/lib/ai/openCodeQuestionReply.test.ts`: regression for selected plus custom; negative cases retained.
- `app/src/features/jarvis-interaction/PlanReviewCard.tsx`: View full plan opens a scrollable dialog with complete summary, steps, and risks above the composer.
- `app/src/features/jarvis-interaction/PlanReviewCard.test.tsx`: verifies late details are in the dialog and opening/closing it does not update plan status or dispatch a send.

Verification:
- PlanReviewCard focused Vitest: 16/16 PASS. `plan-focused.json` records command and source hashes.
- Question builder plus Codex bridge focused Vitest: 30/30 PASS, worker report; TDD red reproduced before fix.
- `npx tsc -p app/tsconfig.json --noEmit --incremental false --pretty false`: exit 0 on stable four-file source; `typecheck-final.json` records hashes.
- Scoped four-file `git diff --check`: exit 0. Question worker Prettier check passed; PlanReviewCard files already failed Prettier at unmodified HEAD, so no broad formatting churn.
- Official native Instance 1 identity verified as jarvis.exe PID24748, child WebView28964, original ai.jarvis.desktop profile, CDP9223. Native read-only DOM sees two View full plan buttons, proving HMR surfaced the code. It did not click the dialog or submit a question. Selected user chat had two durable `running` typed_chat rows despite a Failed status widget; changing chat or answering would risk the user's active session. See `native-operator/selected-chat-status.json`.

Pending: safe native dialog and question submission acceptance, original Prompt 01 remaining harness matrix, current full suite/build/Cargo/installer measurements. AP31 owns app/dist and related broad build output. No root stage, commit, push, or CI.
