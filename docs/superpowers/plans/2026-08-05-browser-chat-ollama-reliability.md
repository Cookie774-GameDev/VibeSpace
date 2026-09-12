# Browser Chat and Ollama Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-respecting Browser Chat engine and make connected Ollama sends settle quickly with output or an actionable failure.

**Architecture:** Keep the existing `chat` route and native Chat tree. A new persisted Browser Chat store and hub own provider selection and isolated managed provider windows, while a bounded completion guard hardens the existing Ollama provider without changing model routing or security policy.

**Tech Stack:** React, TypeScript, Zustand, Tauri 2 WebviewWindow API, Vitest, Testing Library.

## Global Constraints

- Preserve native VibeSpace Chat, Workbench, Vibe Browser, model selection, tools, approvals, and Fully Local behavior.
- Never scrape or restyle provider DOM, intercept provider responses, access provider cookies, or claim unsupported MCP/tool connectivity.
- No new dependency, native command, cloud mutation, or production action.
- Use strict RED/GREEN for every behavior change.

---

### Task 1: Browser Chat registry and persisted engine state

**Files:**

- Create: `app/src/features/browser-chat/providerRegistry.ts`
- Create: `app/src/features/browser-chat/providerRegistry.test.ts`
- Create: `app/src/features/browser-chat/browserChatStore.ts`
- Create: `app/src/features/browser-chat/browserChatStore.test.ts`

**Interfaces:**

- Produces `BrowserChatProviderId`, `BROWSER_CHAT_PROVIDERS`, and `useBrowserChatStore`.

- [ ] Write registry tests proving exact ChatGPT/Claude/Gemini labels, HTTPS homes, unique isolated profile keys, separate page/tool statuses, and no arbitrary provider URL.
- [ ] Run the focused tests and confirm RED because the modules do not exist.
- [ ] Implement the static registry and persisted store with validated hydration.
- [ ] Re-run the focused tests and confirm GREEN.

### Task 2: Isolated managed provider surface

**Files:**

- Create: `app/src/features/browser-chat/providerSurface.ts`
- Create: `app/src/features/browser-chat/providerSurface.test.ts`
- Create: `app/src/features/browser-chat/BrowserProviderSurface.tsx`
- Create: `app/src/features/browser-chat/BrowserProviderSurface.test.tsx`

**Interfaces:**

- Consumes `BrowserChatProviderDefinition`.
- Produces `openManagedProviderSurface`, `hideManagedProviderSurfaces`, and a measured React host.

- [ ] Write failing tests proving only registry URLs are used, each provider gets a unique window label/data directory, web fallback never pretends a managed surface exists, inactive windows hide, and late resize work is cancelled.
- [ ] Run focused tests and confirm RED.
- [ ] Implement lazy Tauri imports, safe labels/profiles, measured bounds, lifecycle cleanup, and explicit errors.
- [ ] Re-run focused tests and confirm GREEN.

### Task 3: Browser Chat hub and two-engine entry

**Files:**

- Create: `app/src/features/browser-chat/BrowserChatHub.tsx`
- Create: `app/src/features/browser-chat/BrowserChatHub.test.tsx`
- Create: `app/src/features/browser-chat/ChatEngineMenu.tsx`
- Create: `app/src/features/browser-chat/ChatEngineMenu.test.tsx`
- Create: `app/src/features/browser-chat/index.ts`
- Modify: `app/src/features/chat/ChatView.tsx`
- Modify: `app/src/features/chat/ChatView.browserGoal.test.tsx`
- Modify: `app/src/components/layout/TopBar.tsx`
- Modify: `app/src/components/layout/TopBar.voiceSmoke.test.tsx`

**Interfaces:**

- Consumes the Browser Chat store and provider surface.
- Preserves the exact native Chat render tree when engine is `native`.

- [ ] Write failing component/source-contract tests for the top-right mode control, native/browser mode selection, provider tabs, truthful page/tool status, plan disclosure, system-browser fallback, and native Chat preservation.
- [ ] Run focused tests and confirm RED.
- [ ] Implement the menu, hub, ChatView branch, and TopBar entry using existing VibeSpace primitives and tokens.
- [ ] Re-run focused tests and confirm GREEN.

### Task 4: Ollama silent-stall guard

**Files:**

- Modify: `app/src/lib/ai/providers/ollama.test.ts`
- Modify: `app/src/lib/ai/providers/ollama.ts`

**Interfaces:**

- Produces `runGuardedNativeOllamaChat`, used only by `ollamaProvider.run`.

- [ ] Add failing tests for abort, first-response timeout, empty output, transient pre-output retry, deterministic no-retry, and exactly-once completion callbacks.
- [ ] Run the Ollama test and confirm RED for the missing guard behavior.
- [ ] Implement the smallest guarded native completion and wire it into the existing native path without changing routing, prompts, model selection, or cloud policy.
- [ ] Re-run Ollama tests and confirm GREEN.

### Task 5: Documentation and closure verification

**Files:**

- Create: `docs/browser-chat/README.md`
- Create: `docs/browser-chat/PROVIDER_FEASIBILITY.md`

**Interfaces:**

- Documents verified implementation separately from provider/runtime checks not exercised.

- [ ] Document setup, provider-owned sign-in, session isolation, subscription limits, system-browser fallback, tool-bridge truthfulness, privacy, and troubleshooting.
- [ ] Record desktop feasibility as `pending physical verification` unless directly exercised; never infer support from unit tests.
- [ ] Run focused Browser Chat, TopBar, ChatView, Ollama, and router tests.
- [ ] Run TypeScript, direct production build, scoped Prettier/diff/secret checks, and bounded native/manual smoke where available.
- [ ] Review the exact diff, update coordination evidence, and release owned paths.
