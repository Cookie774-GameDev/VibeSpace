# Jarvis 0.1.3 — Full Progress Log

_Generated at the end of the build session. Captures everything done across this whole chat, in order, with file paths so you can audit each item. Read top-to-bottom for the story; jump to "File manifest" for the raw list._

---

## TL;DR

Shipped Jarvis **0.1.3**: an AI-proposed **action system** (24 built-in actions with Approve/Cancel cards), a **Custom Tools** page, a **20-20-20 wellness break**, a **Mod+Shift+A actions palette**, a new **Tools** route, a **four-tier pricing ladder** (Free / Starter $5 / Pro $20 / Ultra $100) backed by an entitlements module, and a default-model swap to **Gemini 2.5 Flash Lite**. Built the Windows MSI + NSIS installers, wrote a self-contained Setup Guide, and armed an idempotent **8 AM auto-open** scheduled task. Then audited the whole thing with 5 subagents, found and fixed one parser bug ("open tools" voice nav), and researched the zero-config-model question.

Build status: typecheck clean, Vite bundle clean, Rust release build clean, both installers produced.

---

## 1. Action system (the headline feature)

Jarvis can now propose any of 24 built-in actions inline in chat via a fenced ` ```action ` block. Each renders as an Approve/Cancel card; nothing runs until the user approves. Status lifecycle: `pending → running → success / error / cancelled`, fed back to the AI on its next turn.

- `lib/actions/types.ts` — `ActionDef`, `ActionParam`, `ActionResult` (ok/fail union), `ActionRunContext`, `ActionStatus`, `ParsedActionProposal`.
- `lib/actions/registry.ts` — 24 built-ins across 8 categories. Full list:
  - **navigation (7):** `nav.chat`, `nav.terminal`, `nav.kanban`, `nav.skills`, `nav.benchmarks`, `nav.history`, `nav.tools`
  - **settings (3):** `settings.open`, `settings.providers`, `settings.plans`
  - **theme (3):** `theme.dark`, `theme.light`, `theme.toggle`
  - **voice (1):** `voice.open`
  - **terminal (5):** `terminal.open`, `terminal.swarm`, `terminal.claude`, `terminal.opencode`, `terminal.run` _(destructive)_
  - **chat (1):** `chat.fullscreen`
  - **wellness (2):** `wellness.eyeBreak`, `wellness.endBreak`
  - **host (2):** `host.openUrl`, `host.openLauncher`
  - 9th category `custom` is populated at runtime from the tool store.
- `lib/actions/runner.ts` — `resolveAction`, `runAction` (validates required params, toasts on result), `getAllActions` (built-in + custom, deduped, built-ins win collisions).
- `lib/actions/parse.ts` — line-mode state machine. Looks for fence `^\s*```\s*action\s*$` (case-insensitive). Malformed JSON/ids become visible error segments, not dropped.
- `lib/actions/promptAddendum.ts` — `applyAvailableActions(agent)` appends the catalogue to the system prompt. Applied to **Jarvis only**.
- `lib/actions/index.ts` — barrel.
- `lib/ai/runtime.ts` — splices parsed action blocks into message `parts` at canonical-write; applies the addendum only when `agent.slug === 'jarvis'`.
- `features/chat/ActionApprovalCard.tsx` — the inline card; persists status patches back to the message via `messageRepo`; warns on unregistered `action_id` (AI hallucination guard).
- `features/chat/MessagePart.tsx` — `action_proposal` case (full card when `messageId`+`chatId` present, read-only line otherwise).
- `features/chat/MessageBubble.tsx` — passes `messageId`/`chatId` down.
- `features/council/AgentPanel.tsx` + `features/history/Replay.tsx` — render a compact read-only badge for `action_proposal` parts (no crash, no live re-run in retrospective views).
- `types/chat.ts` — added the `action_proposal` Part kind + `ActionStatus`.

## 2. Custom Tools

- `features/tools/toolStore.ts` — Zustand store, persisted at localStorage key `jarvis-tools` (only the `tools` array). Each tool = `custom.<slug>` wrapping a built-in action with frozen params. `create/update/remove/importMany/slugify/uniqueSlug`. `publish()` is an honest stub returning "available soon".
- `features/tools/ToolsPage.tsx` — editor dialog, 4 quick-start templates, JSON import/export, run-in-place, local badge.
- `features/tools/index.ts` — barrel.

## 3. Wellness break (20-20-20)

- `features/wellness/WellnessBreak.tsx` — full-screen overlay, breathing orb, `requestAnimationFrame` countdown (no `Date.now()` in state), auto-ends at 0, Esc/skip. z-index 80.
- `features/wellness/index.ts` — barrel.
- UI store fields (all transient, not persisted): `wellnessActive/Kind/StartedAt/DurationMs` + `startWellness`/`endWellness`.

## 4. Actions palette

- `features/actions/ActionsPalette.tsx` — `Mod+Shift+A`. Substring search, grouped by category, localStorage "Recent" (cap 5), inline param form when needed.
- `features/actions/index.ts` — barrel.
- `lib/hotkeys.ts` — added `ACTIONS: 'Mod+Shift+A'`.
- `features/settings/sections/Hotkeys.tsx` — added the ACTIONS label row.
- UI store: `actionsPaletteOpen` + `setActionsPaletteOpen`/`toggleActionsPalette`.

## 5. Tools route wiring

New top-level `tools` route added consistently across:
- `stores/ui.ts` (Route union), `components/layout/PageRouter.tsx` (lazy import + routeMap), `components/layout/NavPane.tsx` (Wrench nav item), `components/layout/TopBar.tsx` (Route + ROUTES + ROUTE_LABELS), `features/assistant/parse.ts` (NavRoute + NAV_ROUTE_MAP), `features/assistant/intents.ts` (navigate union), `lib/mcp/builtins.ts` (Route + VALID_ROUTES).

## 6. Pricing — four tiers + entitlements

- `lib/entitlements.ts` — single source of truth. `PlanId = free|starter|pro|ultra`, `PLANS`, `PLAN_ORDER`, helpers `getPlan`/`planAllowsHostedModel`/`planAllowsVoice`/`planVoiceQuota`.
  - **Free $0** — BYOK only, no hosted models, no voice.
  - **Starter $5** — 60 voice min/mo, hosted Flash Lite + Flash, Jarvis Call, cloud sync.
  - **Pro $20** — 300 voice min/mo, + Gemini Pro, Claude Sonnet, GPT-4o, tool/agent publishing, priority routing.
  - **Ultra $100** — unlimited voice, + Claude Opus, GPT-4o 1M, o1/o1-mini, early access.
  - Pricing math targets cost ≤ ~33% of sticker (≈3× markup) to net ≥50% after Stripe + sales tax + income tax.
- `stores/auth.ts` — added persisted `plan: PlanId` (default `free`) + `setPlan` (reserved for the future Stripe webhook).
- `features/settings/sections/Plans.tsx` — redesigned to a 4-card ladder; Free shows "Current", others "Available soon" (disabled CTA) until Stripe ships.

## 7. Default model swap

Seeded default is now **Gemini 2.5 Flash Lite** — the genuinely-free Google quota — so a fresh Free user doesn't bump the metered Flash budget. (Router/models work from earlier in the session.)

## 8. Terminal command queue

- `features/terminals/terminalCommandQueue.ts` — Zustand queue of a discriminated union `{kind:'shell',...} | {kind:'swarm'}`. Helpers `enqueueTerminalCommand` / `requestTerminalSwarm`. Preserves arrival order.
- `features/terminals/TerminalsPage.tsx` — drains on mount (catches anything queued before the lazy chunk loads) AND subscribes for live enqueues. `shell` → `appendLeaf`; `swarm` → `buildSwarmTree()` + tiles mode. Fixes the cold-load race where "Open swarm" was lost on first navigation.

## 9. Version bumps + release notes

Bumped to **0.1.3** in: `app/package.json`, `app/src-tauri/Cargo.toml`, `app/src-tauri/tauri.conf.json`, and `CURRENT_VERSION` in `app/src/features/whats-new/releases.ts`. Added a 0.1.3 release entry (sections: New / Improved / Fixed / Shipped / Known issues).

## 10. Setup guide

- `Setup_Guide_0.1.3.html` (repo root) — self-contained (inlined cozy-palette CSS, no external assets). Sections: Install, First run, Add your first provider, The action system, Custom tools, Actions palette, 20-20-20 break, Plans, Auto-start at 8 AM, Hotkeys, Troubleshooting.

## 11. Build

- `npm run typecheck` — clean.
- `npm run build` (Vite) — clean (2590 modules; one expected 1.6 MB main-chunk warning).
- `npm run tauri:build` — Rust release ~3m38s. Artifacts:
  - `app/src-tauri/target/release/bundle/msi/Jarvis_0.1.3_x64_en-US.msi` (~4.3 MB)
  - `app/src-tauri/target/release/bundle/nsis/Jarvis_0.1.3_x64-setup.exe` (~3.6 MB)
  - `app/src-tauri/target/release/jarvis.exe` (~6.6 MB)

## 12. 8 AM auto-open

- Scheduled task `JarvisMorningOpen`, one-shot, next run 08:00 tomorrow.
- Calls `%LOCALAPPDATA%\Jarvis\jarvis-morning-launcher.ps1` (hidden powershell).
- Launcher is **idempotent**: if a `jarvis.exe` is already running it skips (no duplicate window); otherwise it launches. Logs every run to `%LOCALAPPDATA%\Jarvis\morning-launcher.log`.
- Cancel: `Unregister-ScheduledTask -TaskName JarvisMorningOpen -Confirm:$false`.

## 13. Post-build audit (5 subagents) + bug fix

Five subagents audited routes/versions, artifacts/setup-guide, the action system, the tools/wellness/pricing files, and researched zero-config models.

**Bug found + fixed:** `features/assistant/parse.ts` had `tool`/`tools` in `NAV_ROUTE_MAP` but the `navStrict`/`navPolite` regexes omitted `tools?`, so "open tools" never matched (despite the release note advertising it). Added `tools?` to both alternations. Typecheck clean.

---

## File manifest

**New files (17):**
```
Setup_Guide_0.1.3.html
app/src/lib/entitlements.ts
app/src/lib/actions/types.ts
app/src/lib/actions/registry.ts
app/src/lib/actions/runner.ts
app/src/lib/actions/parse.ts
app/src/lib/actions/promptAddendum.ts
app/src/lib/actions/index.ts
app/src/features/actions/ActionsPalette.tsx
app/src/features/actions/index.ts
app/src/features/tools/toolStore.ts
app/src/features/tools/ToolsPage.tsx
app/src/features/tools/index.ts
app/src/features/wellness/WellnessBreak.tsx
app/src/features/wellness/index.ts
app/src/features/chat/ActionApprovalCard.tsx
app/src/features/terminals/terminalCommandQueue.ts
```

**Edited files (this session's 0.1.3 work):**
```
app/package.json
app/src-tauri/Cargo.toml
app/src-tauri/tauri.conf.json
app/src/App.tsx
app/src/lib/hotkeys.ts
app/src/lib/ai/runtime.ts
app/src/lib/mcp/builtins.ts
app/src/stores/ui.ts
app/src/stores/auth.ts
app/src/types/chat.ts
app/src/components/layout/PageRouter.tsx
app/src/components/layout/NavPane.tsx
app/src/components/layout/TopBar.tsx
app/src/features/assistant/parse.ts
app/src/features/assistant/intents.ts
app/src/features/chat/MessagePart.tsx
app/src/features/chat/MessageBubble.tsx
app/src/features/council/AgentPanel.tsx
app/src/features/history/Replay.tsx
app/src/features/settings/SettingsModal.tsx
app/src/features/settings/sections/Hotkeys.tsx
app/src/features/settings/sections/Plans.tsx
app/src/features/terminals/TerminalsPage.tsx
app/src/features/whats-new/releases.ts
```

---

## Known gaps / next (0.1.4)

- **Stripe** not wired — paid tiers say "Available soon". `entitlements.ts` is the ready source of truth; the only change is flipping `useAuthStore().plan` from a webhook.
- **Tool publishing** to Jarvis Cloud is a stub (Export/Import works locally).
- **Zero-config AI** — Gemini API requires a (free, no-card) key; there is no keyless path. The only true out-of-the-box-no-key option is a bundled local model. See the "Zero-config model" answer in chat. Big architectural fork — awaiting a go/no-go.
- **Live agent orchestration** in the terminal swarm (pane output → matching agent chat) still not landed.
- Main JS chunk is 1.6 MB; splitting provider adapters into a dynamic chunk would help.
