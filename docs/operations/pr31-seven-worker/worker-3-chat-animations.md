# PR31 Worker 3 — Chat, token modes, Prompt Forge, and activity motion

## Scope and authority

- Task: `VS-PR31-W3-CHAT-ANIMATIONS-20260808`
- Role: Worker 3 Chat/Animations writer
- Starting HEAD: `b81d93489b39b307204fbb7b6747799d50c32384`
- Requirement authority: master section 10 plus the controller's current seven-category mapping
- Primary ownership: Chat, Prompt Forge, token optimizer, loading animation, and this report
- Recorded narrow extension: activity-category fields and focused assertions in
  `app/src/lib/ai/runtime.ts`, `runtime.test.ts`,
  `app/src/lib/jarvis/executionJournal/legacyActivityProjection.ts`, and its test
- External mutations: none

## Root cause and correction

Commit `8727654` intentionally reduced every live activity to `cursor-forge`.
That met an older single-motion requirement but made the seven existing
animations unreachable. The activity model also exposed only six coarse kinds,
so response composition and thinking could be distinguished only by English
titles.

`ChatActivityCategory` is now an optional, backward-compatible structured
semantic:

| Structured category | Motion               |
| ------------------- | -------------------- |
| `thinking`          | `cursor-forge`       |
| `file`              | `stack-shift`        |
| `writing`           | `code-shimmer`       |
| `coordination`      | `nine-dot-fold`      |
| `context`           | `twin-loop`          |
| `learning`          | `breathing-brackets` |
| `response`          | `glyph-current`      |

The resolver:

- animates only `pending` and `running`;
- stops for `done`, `error`, `cancelled`, or missing status;
- prefers the structured category;
- falls back deterministically from the structured legacy kind;
- ignores English title/detail/file text;
- falls back safely to structured kind and then generic thinking when persisted
  data contains unknown category or kind values.

The live runtime now records thinking, coordination, file, context, learning,
writing, and response transitions at the points where it already has
authoritative state. Canonical journal projection maps memory context to
context, retrieval/search to file, tool execution to thinking, artifacts to
file, and messages to response. No provider, model, action, approval,
persistence, or execution behavior was changed.

Statusless historical command and reasoning transcript blocks remain still
even when a later session is live. Only blocks carrying authoritative
`pending` or `running` activity evidence may animate.

Compact Agentic Console rows now pass their compact state into every motion
component. All motion remains decorative (`aria-hidden="true"`). The existing
CSS reduced-motion boundary was exercised in headless Chromium: normal
`code-shimmer` computed to `agent-motion-code-shimmer`; after emulating
`prefers-reduced-motion: reduce`, the computed animation was `none`.

## Section 10 evidence map

| Requirement area                                | Focused evidence                                                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seven mappings and structured fallback          | `AgentMotionIndicator.test.tsx`                                                                                                                            |
| Pending/running/terminal/rapid transitions      | `AgentMotionIndicator.test.tsx`, `AgenticConsole.test.tsx`                                                                                                 |
| Standard/compact/accessibility                  | `AgentMotionIndicator.test.tsx`, `AgenticConsole.test.tsx`, Chromium reduced-motion probe                                                                  |
| Category projection and canonical events        | `projection.test.ts`, `legacyActivityProjection.test.ts`                                                                                                   |
| Live response and learning producer transitions | focused assertions in `runtime.test.ts`                                                                                                                    |
| Chat lifecycle/history/branching                | `chatLifecycle.test.ts`, `chatUndoRedo.test.ts`, `ChatThread.sessionPanel.test.ts`                                                                         |
| Queue/cancel/mode transitions                   | `composerQueuePolicy.test.ts`, `QueuedMessagesBar.test.tsx`, `modeTransitionSafety.test.ts`                                                                |
| Images/files/video/oversize/output inventory    | `imageAttachments.test.ts`, `videoAttachments.test.ts`, `ComposerMediaStrip.test.tsx`, `oversizedMessageAttachment.test.ts`, `chatOutputInventory.test.ts` |
| Malformed/unsafe output containment             | `agentic-console/projection.test.ts`, `composerSendFailures.test.ts`                                                                                       |
| Prompt Forge review/send/recovery/source safety | Prompt Forge focused directory plus `Composer.promptForge.test.tsx`                                                                                        |
| Token modes and per-chat persistence            | token optimizer focused directory plus Composer mode/reasoning tests                                                                                       |

The first combined 106-file domain run exercised the complete owned test
surface. One load-sensitive `ChatThread.agentPanel.test.tsx` case exceeded its
5-second default while all files ran concurrently, after which the worker IPC
channel closed. The exact file passed independently in 1.93 seconds. Final
evidence below records the bounded reruns rather than treating the worker
channel closure as a product pass.

## Deterministic token-mode comparison artifact

The comparison uses one identical context-budget fixture for all modes:

- model context: 2,000 tokens;
- requested output: 1,000 tokens;
- fixed input plus protected context: 400 tokens;
- optional context: high relevance 400, medium relevance 300, low relevance
  200, and one 400-token duplicate;
- estimated input before optimization: 1,700 tokens.

The values below follow the checked `buildTokenBudgetPlan` policy and its
focused mode tests. They are estimates, not provider usage:

| Mode         | Selected optional context    | Excluded context                | Input after | Estimated saved | Output limit | Estimated input + output | Fits |
| ------------ | ---------------------------- | ------------------------------- | ----------: | --------------: | -----------: | -----------------------: | ---- |
| `off`        | high, medium, low, duplicate | none                            |       1,700 |               0 |        1,000 |                    2,700 | no   |
| `saver`      | high                         | medium, low, duplicate          |         800 |             900 |          512 |                    1,312 | yes  |
| `normal`     | high                         | medium (budget), low, duplicate |         800 |             900 |        1,000 |                    1,800 | yes  |
| `final_boss` | high, low                    | medium (budget), duplicate      |       1,000 |             700 |        1,000 |                    2,000 | yes  |

All modes preserve protected content and forbid model switching. `off` reports
zero savings. No wall-clock latency, time-to-first-token, actual output-token,
or answer-quality delta is claimed from this deterministic fixture. The
controller explicitly transferred existing verified Jarvis/local-provider
quality work out of this slice, so this worker did not rerun or alter it.

## Verification ledger

Final commands and results are recorded here before handoff:

- strict corrected-mapping RED: 11 expected failures reproduced the stale
  category table, kind fallback, unknown-kind `undefined`, console transition,
  and canonical projection mismatches;
- strict runtime producer RED: the profile-learning assertion received the
  stale `thinking` category instead of `learning`;
- focused animation/console/projection/legacy GREEN: 4 files, 52 tests;
- focused runtime producer GREEN: 2 selected tests (82 unrelated tests skipped);
- Prompt Forge/token optimizer/loading GREEN: 32 files, 192 tests;
- bounded Chat GREEN: 73 files, 345 tests. The remaining
  `monochromeFixture.test.ts` suite could not resolve the deliberately absent
  sparse-worktree dependency `tests/visual/monochrome/fixtures`. Existing
  `ChatThread.commandCenter` React `act` warnings remain non-failing;
- the previously load-sensitive Agent panel case passed within the bounded Chat
  run (1.11 seconds);
- real Chromium reduced-motion/accessibility probe: normal animation name
  `agent-motion-code-shimmer`, reduced animation name `none`,
  `aria-hidden="true"`;
- TypeScript: repository command reaches missing sparse-worktree paths outside
  this worker's ownership (10 diagnostics); no diagnostic named a changed file;
- formatting: exact touched paths passed Prettier;
- `git diff --check`: passed;
- ownership-path audit: passed;
- added-line secret scan: passed.

## Risks and rollback

- Older persisted events without `category` use the deterministic kind fallback.
- Canonical event types do not expose distinct writing, coordination, or
  learning event types; those categories come from the live runtime where that
  state exists.
- Native installed-app visual interaction was not performed in this worker
  worktree.
- Rollback is the exact Worker 3 diff. Removing the optional category fields
  restores the prior single-motion behavior without data migration.
