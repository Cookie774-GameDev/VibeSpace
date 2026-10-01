# PR31 Worker 2 — Jarvis, Ollama, Actions, and Multitask

## Scope

- Task: `VS-PR31-W2-JARVIS-OLLAMA-20260808`
- Starting HEAD: `b81d93489b39b307204fbb7b6747799d50c32384`
- Authority: master section 9 and scenarios A–D
- External mutation: none
- Model download or deletion: none

## Preserved verified behavior

Current PR31 code and focused regression coverage already prove the following
substantial behavior, so this worker did not replace or duplicate it:

- local Ollama responses use authoritative native IPC with bounded retry,
  first-response timeout, cancellation, installed-model discovery, and pull/delete
  lifecycle contracts;
- local action prose cannot become fabricated completion and file, terminal,
  creator, agent, and skill actions remain bound to canonical approval authority;
- Fully Local mode excludes cloud models and public escalation, while opt-in
  escalation returns a disclosure that still requires approval before data is sent;
- Deep mode supplies the Planner → Executor → Verifier contract and local Final
  Boss performs one private bounded critique/revision pass;
- child-agent launch, native-chat pinning, parent/child cards, canonical live status,
  bounded display, and terminal completion reconciliation have focused coverage.

## Proven remaining gaps and repairs

### Restart persistence failed open

The persisted interaction store serialized session-only plan approval and active
child statuses unchanged. A renderer restart could therefore restore stale
`queued`, `thinking`, `editing`, or similar work with no owning runtime, and could
retain prior plan-safe approval.

Persistence version 2 now:

- clears plan-safe approval before writing or migrating persisted state;
- converts every nonterminal child status to an explicit failed
  `Interrupted by app restart` result;
- preserves already terminal child results;
- sanitizes both version migrations and current-version hydration while
  preserving live store methods;
- drops malformed persisted rows instead of breaking application startup;
- covers all seven active statuses: `queued`, `thinking`, `planning`,
  `asking_question`, `waiting_permission`, `editing`, and `testing`.

### Ollama bootstrap cancellation crossed callers

The app deduplicated bootstrap with one promise whose underlying signal belonged to
the first caller. Unmounting that caller could abort another mounted consumer.

The bootstrap now owns one internal controller and gives each caller an independent
subscription. One caller may cancel without cancelling another; the underlying
probe aborts only when its final subscriber leaves. The mounted connection host
passes a lifecycle signal to initial, focus, and background probes and suppresses
expected unmount-abort warnings. An already-aborted caller now fails before
ready-cache invalidation, flight creation, or any provider request.

### Planner timeout left execution alive

The typed planner previously raced a timeout against an already-started action
promise, so it could report failure while the action continued without any
cancellation channel.

The executor now receives a dedicated `AbortSignal`. Timeout or caller
cancellation aborts that signal before the plan records its terminal result.

## Model inventory and bounded live evidence

Read-only inventory on 2026-08-09:

- `llama3.2:latest`, ID prefix `a80c4f17acd5`, approximately 2.0 GB;
- `qwen2.5:1.5b-instruct-q4_K_M`, ID prefix `65ec06548149`, approximately
  986 MB;
- no model was initially running.

One bounded `llama3.2:latest` `/api/chat` probe used `stream=false`,
`keep_alive=0`, temperature 0, `num_predict=24`, and a 180-second HTTP timeout.
It did not return; the containing command timed out after 205 seconds. This is
failed environment evidence, not a successful completion.

After the timeout:

- `/api/version` remained healthy at Ollama `0.21.0`;
- direct `/api/ps` returned an empty model list, restoring the initial no-running
  state;
- the `ollama ps` CLI separately failed to allocate memory under current host
  pressure;
- no model was downloaded, removed, or left loaded.

Real Llama completion and destructive remove/reinstall proof therefore remain
blocked by current host memory pressure and controller scheduling requirements.

## Verification

- RED/GREEN:
  - interaction restart migration/serialization, current-version merge
    sanitation, all active statuses, and malformed persistence;
  - independent shared-bootstrap cancellation, pre-aborted zero-provider work,
    and host unmount cleanup;
  - executor abort before planner timeout completion.
- Focused gate: 13 files, 162 tests passed.
- TypeScript:
  - the first repository run identified and led to correction of the owned
    Zustand persisted-state generic, alongside unrelated sparse-worktree missing
    imports;
  - a second repository run timed out under concurrent host load;
  - a compiler-API check using `app/tsconfig.json` and the eight exact changed
    TypeScript/TSX roots passed with no diagnostics.
- Focused native `kernel_host::tests` did not reach test execution because the
  sparse worktree omits the configured `resources/intro/*` path required by the
  Tauri build script. No native source changed in this worker.

## Rollback

Revert only the eight Worker 2 source/test paths and this report. No external or
model state needs rollback.

## Native exact-output and token-motion follow-up

Task `VS-PR31-W2-FIX-NATIVE-CHAT-COMPLIANCE-20260809` repaired two defects
reproduced in the fixed-watchdog native session:

- `llama3.2:latest` emitted `TOKEN-SAVER-OK` for the requested literal
  `TOKEN_SAVER_OK`, and emitted `FINAL BOSS OK!` for `FINAL_BOSS_OK`. The
  sanitizers preserved those responses unchanged, so the missing behavior was a
  bounded final-response contract rather than character corruption in the
  pipeline.
- `AnimatePresence mode="popLayout"` attempted to attach a ref to the
  function-form `InputToken`. Its blur keyframes also inherited a spring that
  could overshoot below zero and generate invalid CSS filter values.

The runtime now restores only one explicit uppercase underscore-delimited
literal when the entire trimmed response contains the identical uppercase token
segments separated only by underscores, hyphens, or spaces, with at most three
terminal `.`, `!`, or `?` characters. It rejects ambiguous, multiline,
oversized, lowercase/mixed-case wrappers, refusals, prose, emoji, unexpected
symbols, action syntax, extra identifiers, and materially different responses.
Token Saver still performs one provider call. For this narrow contract it
buffers message and voice deltas, reconciles once, and emits the truthful final
response once; ordinary Token Saver prompts retain streaming. Local Final Boss
keeps its bounded two-call draft/revision pass and applies the same contract only
to the selected final answer.

`InputToken` now forwards its root DOM ref. Its scale and position motion retain
the theme-selected transition, while filter animation uses a non-overshooting
tween; reduced motion keeps the filter transition at zero duration.

Focused RED evidence reproduced all five intended failures: both observed model
variants, the `PopChild` ref warning, and the default/reduced filter-transition
contracts. Focused GREEN evidence passed 103 tests across runtime, local Final
Boss, InputToken, and Sakura motion. `npm run typecheck` also passed.

Review follow-up task `VS-PR31-W2-FIX-EXACT-LITERAL-REVIEW-20260809` added
negative coverage for lowercase and mixed-case wrappers, refusal prose, emoji,
unexpected separators, extra identifiers, action syntax, and multiline output.
Its RED run exposed four unsafe erasures, the missing narrow request detector,
and three raw Token Saver message writes before reconciliation. The focused
GREEN run passed 106 helper, runtime, and Final Boss tests; TypeScript and
focused formatting also passed.

### Independent native acceptance script

After integrating and rebuilding the native app, a different worker should:

1. Acquire the exclusive native UI lease and record the current renderer route,
   selected theme, watchdog reload-line count, and console warning/error count.
   Do not change the theme or restart/reload the app.
2. Create one empty native chat, select the already-installed
   `llama3.2:latest`, select Token Saver, and send exactly
   `Reply with exactly: TOKEN_SAVER_OK`.
3. Require the rendered assistant text to be exactly `TOKEN_SAVER_OK`, the mode
   indicator to remain Token Saver, the displayed model to remain
   `llama3.2:latest`, and only one provider activity/run to be visible. The
   assistant bubble must not first show `TOKEN-`, `TOKEN-SAVER-OK`, or another
   raw intermediate and then replace it. If spoken reply is enabled without
   changing app settings, require one final `TOKEN_SAVER_OK` delivery and no raw
   intermediate speech.
4. Select Token Final Boss and send exactly
   `Return exactly FINAL_BOSS_OK after checking your answer twice.`
5. Require the rendered assistant text to be exactly `FINAL_BOSS_OK`, the mode
   indicator to remain Token Final Boss, and the bounded activity to complete
   without a third provider pass.
6. Add and remove one composer input token through a normal local UI control.
   Require no `Function components cannot be given refs`/`PopChild` warning and
   no negative-blur or invalid CSS filter warning. Confirm reduced-motion
   behavior too only if it can be inspected without changing app/theme state.
7. Reopen the existing terminal pane without overwriting it and confirm the
   prior marker remains rendered, or use at most one fresh pane to run exactly
   `echo VIBESPACE_NATIVE_TERMINAL_OK_2` once if the marker is absent.
8. Record response and terminal latencies, route/model/mode persistence, final
   console warning/error delta, and watchdog reload-line delta. Acceptance
   requires zero new watchdog reload lines and no renderer instability. Close
   every CDP socket and release the UI lease.
