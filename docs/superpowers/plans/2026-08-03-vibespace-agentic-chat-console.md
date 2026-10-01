# VibeSpace Agentic Chat Console Implementation Plan

**Task:** `VS-PR31-AGENTIC-CHAT-CONSOLE-20260803T011856Z-ROOT`

**Goal:** Replace the narrow bubble-first transcript with a truthful, full-width
agentic console projection while preserving the existing chat/runtime data
model, approval surfaces, composer behavior, persistence, and classic fallback.

## 1. Canonical projection and safety

- Add typed transcript blocks derived only from persisted `Message` parts and
  canonical `ChatActivityEvent` records.
- Pair real tool calls/results, preserve stable ordering, deduplicate canonical
  events, and render actual diff payloads only.
- Strip ANSI/OSC control data and bound output, diff, and mounted transcript
  payloads without deleting canonical history.
- RED/GREEN tests: semantic mapping, orphan results, duplicate events, actual
  diff preservation, no fabricated diff, hostile output, and legacy fallback.

## 2. Console preferences and commands

- Add a versioned, fail-safe presentation preference store for classic/agentic
  mode, density, caret style, and ten scoped console profiles.
- Route `/theme` to console profiles and `/appearance` to the existing official
  global appearance registry. Preserve legacy `/theme` appearance aliases with
  a migration notice.
- RED/GREEN tests: invalid storage, profile aliases, legacy routing, and global
  appearance routing.

## 3. Full-width renderer

- Implement compact session header, full-width prompt bands, semantic activity
  rows, command/output blocks, soft unified diffs, usage, final answer, and
  fallback structured-message rendering.
- Add bounded 400-block viewport with 100-block history paging, jump-to-latest,
  keyboard-visible controls, reduced motion, responsive behavior, and an error
  boundary that restores the classic transcript.
- RED/GREEN component and CSS-contract tests.

## 4. Minimal integration and verification

- Select the new renderer inside `ChatThread` without changing runtime stores,
  approval navigation, command-center controls, working-state behavior, or the
  real composer textarea.
- Run focused agentic-console, ChatThread, Composer theme, slash command,
  command-center, creator, and fixture regressions.
- Run TypeScript, production build, formatting/diff checks, and an added-line
  secret scan. Inspect the live local surface when available without closing
  the installed app or mutating external systems.
