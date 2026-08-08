# VibeSpace MCP Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy and verify one branded VibeSpace MCP gateway that exposes only currently available, account/project-scoped VibeSpace tools and preserves explicit approval for mutations.

**Architecture:** Deploy a small Cloudflare Worker with an official
Streamable HTTP MCP boundary, Supabase OAuth 2.1 verification, and one
SQLite-backed Durable Object per VibeSpace account. Keep all local execution
inside the outbound desktop relay and existing VibeSpace permission broker;
the provider page receives no direct Tauri authority.

**Tech Stack:** Cloudflare Workers, SQLite Durable Objects, WebSocket
Hibernation, MCP TypeScript SDK 2, Supabase OAuth 2.1/ES256, React/TypeScript,
Tauri desktop relay, Vitest Workers pool, Wrangler 4, and focused Python
compatibility tests.

## Global Constraints

- Public name is exactly `VibeSpace MCP`; use an existing official VibeSpace logo.
- Deploy only against verified VibeSpace Supabase project `tipeobvisjqvpbzcpckh`.
- Never mutate AccessRevamp project `vbkkimvedmklebghtkzs`.
- Reads remain scoped; writes, terminal commands, and browser mutations require existing explicit approval.
- Do not expose absolute roots, raw secrets, provider credentials, or unrestricted provider-WebView authority.
- Do not touch protected Warm-theme files, `install/install.ps1`, `qa/**`, or dirty `phone-jarvis/cloud/bridge_endpoint.py`.

---

### Task 1: Branded capability catalog and safe facade

**Files:**

- Modify: `phone-jarvis/cloud/browser_chat_mcp.py`
- Test: `phone-jarvis/cloud/test_browser_chat_mcp.py`

**Interfaces:**

- Consumes: `BridgeSession` advertised tool metadata and `BridgeRegistry.invoke(...)`.
- Produces: `vibespace.get_capabilities` with classified availability and stable `VibeSpace MCP` server metadata.

- [ ] **Step 1: Add failing catalog tests**

Assert the server name is `VibeSpace MCP`, available tools are derived from the
authenticated relay session, unsupported tools are unavailable, and mutation
tools are never advertised without an approval-capable relay contract.

- [ ] **Step 2: Run the focused test**

Run: `python -m pytest phone-jarvis/cloud/test_browser_chat_mcp.py -q`

Expected: new catalog assertions fail before implementation.

- [ ] **Step 3: Implement the minimal typed catalog**

Add immutable tool descriptors containing stable name, category,
classification, availability, and approval requirements. Preserve the existing
four read-only facade tools and map only relay-advertised capabilities.

- [ ] **Step 4: Run the focused test**

Run: `python -m pytest phone-jarvis/cloud/test_browser_chat_mcp.py -q`

Expected: all MCP service and protocol tests pass.

### Task 2: Free Cloudflare gateway and account relay

**Files:**

- Create: `workers/vibespace-mcp/**`

**Interfaces:**

- Consumes: Supabase ES256 JWTs, Streamable HTTP MCP requests, and signed
  desktop relay tickets.
- Produces: `/health`, OAuth protected-resource metadata, `/mcp`,
  `/relay/ticket`, and an account-scoped hibernatable WebSocket relay.

- [x] **Step 1: Add strict Worker security and protocol tests**

Cover protected-resource metadata, anonymous denial, OAuth client identity,
HMAC ticket expiry/tampering/replay, Durable Object account isolation,
registration validation, read routing, mutation denial, and branded MCP
initialization.

- [x] **Step 2: Implement the Worker and SQLite Durable Object**

Use one Durable Object name per verified Supabase subject. Persist only opaque
workspace metadata and advertised tool identifiers. Keep absolute paths and
provider credentials on-device. Accept only one-use relay tickets and
read-only protocol-v2 registrations.

- [x] **Step 3: Verify the free deployment package**

Run:
`npm --prefix workers/vibespace-mcp test`

Run:
`npm --prefix workers/vibespace-mcp run typecheck`

Run:
`npx --prefix workers/vibespace-mcp wrangler deploy --dry-run --config workers/vibespace-mcp/wrangler.jsonc`

Expected: all Worker tests, TypeScript, and the Cloudflare bundle gate pass.

### Task 3: Desktop relay classifications and approvals

**Files:**

- Modify: `app/src/lib/bridge/BridgeClient.ts`
- Modify: `app/src/lib/bridge/BridgeClient.test.ts`
- Modify: `app/src/lib/bridge/useBrowserChatRelay.ts`
- Modify: `app/src/lib/bridge/useBrowserChatRelay.test.tsx`

**Interfaces:**

- Consumes: the existing workspace grant and VibeSpace action-approval broker.
- Produces: a bounded advertised capability manifest and rejects mutations without an exact approval receipt.

- [x] **Step 1: Add relay ticket and policy tests**

Cover read-only startup, optional classified capabilities, wrong account/project,
unadvertised tools, missing approvals, replay, expiry, request limits, and
sanitized failures.

- [x] **Step 2: Implement automatic ticket exchange**

Run:
`npm --prefix app test -- src/lib/bridge/BridgeClient.test.ts src/lib/bridge/useBrowserChatRelay.test.tsx`

The signed-in desktop obtains a one-use 60-second relay URL over authenticated
HTTPS, reconnects with bounded exponential backoff, and refreshes the ticket
whenever its Supabase session changes. The WebSocket URL never contains the
Supabase token.

- [x] **Step 3: Re-run focused relay tests**

Run:
`npm --prefix app test -- src/lib/bridge/BridgeClient.test.ts src/lib/bridge/useBrowserChatRelay.test.tsx`

Expected: all focused tests pass.

### Task 4: Browser Chat one-connector UX

**Files:**

- Modify: `app/src/features/browser-chat/BrowserChatHub.tsx`
- Modify: `app/src/features/browser-chat/BrowserChatHub.test.tsx`

**Interfaces:**

- Consumes: configured `VibeSpace MCP` public endpoint and live relay status.
- Produces: honest one-time ChatGPT connection guidance and automatic post-approval relay reconnect.

- [x] **Step 1: Add failing user-flow tests**

Verify the page shows the exact app name, connected/disconnected states,
available categories, approval requirements, official endpoint copy/open
actions, and no claim that OAuth approval can be bypassed.

- [x] **Step 2: Run focused Browser Chat tests**

Run:
`npm --prefix app test -- src/features/browser-chat/BrowserChatHub.test.tsx`

Expected: the new connection and catalog copy assertions fail.

- [x] **Step 3: Implement focused connection state**

Reuse existing UI primitives. Keep ChatGPT embedded-provider behavior intact,
surface one VibeSpace MCP connection, and reconnect the desktop relay only
after an active workspace grant exists.

- [x] **Step 4: Re-run focused frontend tests and TypeScript**

Run:
`npm --prefix app test -- src/features/browser-chat/BrowserChatHub.test.tsx`

Run:
`npm run typecheck`

Expected: focused tests and TypeScript pass.

### Task 5: Cloudflare deployment and live protocol verification

**Files:**

- Modify: `docs/browser-chat/PROVIDER_FEASIBILITY.md`
- Modify: `docs/operations/PR31_EXECUTION_LEDGER.md`

**Interfaces:**

- Consumes: verified VibeSpace Cloudflare account, VibeSpace Supabase OAuth
  issuer, and the tested Worker bundle.
- Produces: public HTTPS MCP endpoint and truthful live evidence.

- [x] **Step 1: Verify owner-controlled identities**

Confirm Cloudflare account `0aaf188d9d8184defe86953e9191d3aa`,
workers.dev subdomain `combatonline02`, and Supabase project
`tipeobvisjqvpbzcpckh`. Explicitly exclude the existing `accessrevamp` Worker
and Supabase project `vbkkimvedmklebghtkzs`.

- [x] **Step 2: Deploy the exact tested Worker**

Create only `vibespace-mcp`, bind its `UserRelay` Durable Object, store a
generated `RELAY_TICKET_KEY` as an encrypted Worker secret, and enable the
workers.dev route. Do not change `accessrevamp`.

- [ ] **Step 3: Exercise the public boundary**

Verify `/health`, OAuth metadata, unauthenticated denial, MCP initialize/tool
discovery, one approved read, and one denied mutation. Record exact statuses
without storing tokens or user content.

Live health, metadata, origin denial, anonymous MCP denial, relay denial, and
OAuth discovery/DCR are verified. An account-authorized read remains gated on
the owner's one-time ChatGPT OAuth connection and an active desktop workspace
grant.

- [ ] **Step 4: Register and test ChatGPT app**

Enable Supabase OAuth 2.1 with dynamic registration only after the consent UI
is live. Create/connect `VibeSpace MCP` with the official logo, approve OAuth once, and
verify catalog visibility plus desktop reconnect. If owner authentication or
account eligibility blocks registration, record the exact external gate while
preserving the fully tested deployed endpoint.

Supabase OAuth, PKCE discovery, dynamic registration, and the live consent
page are enabled. The remaining account-dependent step is the owner's
one-time connection in ChatGPT.

- [ ] **Step 5: Update evidence and publish the focused commit**

Run formatting, `git diff --check`, focused secret scans, stage only owned
paths, commit, and push normally to PR #31. Never stage protected dirty paths.
