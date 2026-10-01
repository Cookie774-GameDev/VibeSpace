# VibeSpace Web Account and Live Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing `vibespaceos.com/account/` hub into a secure production dashboard with sign-up, sign-in, six-digit password recovery, authoritative usage and billing, live desktop/project/plugin status, and explicitly authorized read-only terminal previews.

**Architecture:** Extend the already-deployed static account hub instead of creating a second web application. Supabase remains the authority for Auth, subscriptions, usage, account-scoped metadata, and private realtime broadcasts; the desktop publishes bounded metadata through hardened RPCs. Sensitive terminal output uses a separate short-lived Cloudflare Durable Object relay, is disabled by default, never enables remote input, and never persists raw output in Postgres.

**Tech Stack:** Existing static HTML/CSS/ES modules, Supabase Auth/Postgres/RLS/Edge Functions/Realtime Broadcast, existing Tauri/React desktop app, Cloudflare Workers and Durable Objects Hibernation WebSocket API, Node test runner, Vitest, TypeScript, Playwright and axe-core.

## Global Constraints

- The dashboard route remains `https://vibespaceos.com/account/`; do not create a competing account identity or billing system.
- Use exactly six numeric digits for sign-up, email sign-in, and password-recovery codes.
- Custom SMTP is required before production launch; Supabase's built-in sender is demonstration-only and currently limited to two combined sign-up/recovery emails per hour.
- Browser code may contain only the Supabase URL and `sb_publishable_...` key. Service-role, Stripe, SMTP, relay-signing, and provider secrets remain server-side.
- Subscription labels, access entitlement, renewal state, cancellation state, and usage totals must come from server-managed rows or authenticated Edge Functions; never infer them from redirects or client storage.
- Metadata presence is account scoped and read-only on the website. No terminal command, chat body, prompt, local path, plugin credential, API key, cookie, or provider token may enter `desktop_presence`.
- Terminal preview is disabled by default, read-only, manually approved per terminal, expires after 15 minutes, and has no remote command-input protocol.
- The dashboard must never display raw model prompts. It may display provider, model, request state, token/cost metadata, elapsed time, and sanitized activity labels.
- Terminal preview frames are capped at 16 KiB; batches flush at 100 ms or 16 KiB; the dashboard retains at most 256 KiB per visible terminal in memory.
- Raw terminal preview is not written to Postgres, D1, R2, KV, analytics, logs, crash reports, or browser persistence.
- Active metadata publishes on change with a five-second minimum interval and sends a full heartbeat every 20 seconds. Dashboard state is stale after 45 seconds and offline after 60 seconds.
- Realtime channels are private and account scoped. A 15-second authenticated polling fallback is required when Realtime is unavailable.
- All account transitions invalidate delayed work from the previous user before rendering.
- Reduced-motion, keyboard-only operation, screen-reader labels, responsive layouts from 360 px through 2560 px, and truthful loading/degraded/offline states are release requirements.
- Implementation follows TDD, focused review per task, no unrelated dirty-file edits, and a dedicated commit after each accepted task.

---

## Product Boundary and Existing Foundation

The repository already contains:

- `site/account/`: deployed sign-in, email OTP, authoritative plan/usage reads, device cards, and 30-second refresh.
- `app/src/features/access/DesktopPresencePublisher.tsx`: signed-in desktop metadata collector and heartbeat.
- `app/src/lib/supabase/desktopPresence.ts`: client-side bounded sanitization and RPC calls.
- `supabase/migrations/0041_desktop_presence.sql`: account-scoped RLS, strict JSON validation, publishing, offline marking, and device revocation.
- `supabase/functions/create-checkout-session`, `create-customer-portal`, `get-message-usage`, and `stripe-webhook`: authenticated billing and usage authority.
- `workers/vibespace-mcp`: an existing Cloudflare worker that exposes only public Supabase configuration and MCP relay behavior.

The implementation must preserve this safe metadata-only path. Terminal preview is a separate capability, not an expansion of `desktop_presence`.

## Planned File Map

### Website account hub

- Modify `site/account/index.html`: authenticated route shell, sign-up/recovery views, overview/usage/billing/devices/projects/plugins/terminal tabs.
- Modify `site/account/account.css`: responsive dashboard layout and accessible live-state styling.
- Split `site/account/account.js` into an orchestration entrypoint that imports focused modules.
- Create `site/account/auth-model.mjs`: normalized auth input, six-digit phase machine, generation invalidation, generic errors, and secret clearing.
- Create `site/account/auth-controller.js`: Supabase sign-up/sign-in/email-code/recovery operations.
- Create `site/account/dashboard-data.js`: authoritative account queries and normalized view model.
- Create `site/account/dashboard-realtime.js`: private Broadcast subscription plus polling fallback.
- Create `site/account/dashboard-render.js`: DOM-only rendering with text nodes and no HTML injection.
- Create `site/account/terminal-preview.js`: grant lifecycle and bounded in-memory ANSI terminal renderer.
- Extend `site/account/account-model.mjs`: versioned presence normalization and stale/offline truth.

### Desktop metadata and terminal relay

- Modify `app/src/features/access/DesktopPresencePublisher.tsx`: change-aware heartbeat and new safe metadata.
- Modify `app/src/lib/supabase/desktopPresence.ts`: version-two snapshot types/sanitization.
- Create `app/src/features/access/desktopPresenceCollector.ts`: terminals/projects/plugins/runtime/usage aggregation.
- Create `app/src/features/terminals/terminalPreviewGrantStore.ts`: exact account/device/terminal grant state.
- Create `app/src/features/terminals/terminalPreviewSanitizer.ts`: ANSI/control stripping, bounded line/frame redaction.
- Create `app/src/features/terminals/terminalPreviewRelay.ts`: outbound-only authenticated WebSocket publisher.
- Modify the exact terminal output-router seam identified during implementation to duplicate already-rendered PTY output into the preview relay without changing terminal rendering.

### Supabase

- Create `supabase/migrations/0042_desktop_presence_v2.sql`: safe projects/plugins/runtime fields and private Broadcast trigger.
- Create `supabase/migrations/0043_terminal_preview_grants.sql`: short-lived grant metadata and RPCs; no output table.
- Create `supabase/functions/create-terminal-preview-ticket/index.ts`: authenticated, one-use publisher/viewer tickets.
- Create `supabase/functions/revoke-terminal-preview/index.ts`: exact owner-bound revocation.
- Create focused Edge Function tests beside both functions.

### Cloudflare

- Create `workers/dashboard-relay/`: isolated Worker/DO package, bindings, schemas, JWT verification, ticket verification, session coordination, redaction enforcement, tests, and runbook.

### Verification and operations

- Extend `site/tests/account-hub.test.mjs`.
- Create `site/tests/account-auth.test.mjs`, `account-realtime.test.mjs`, and `terminal-preview.test.mjs`.
- Create `qa/dashboard/account-dashboard.spec.ts` for browser, accessibility, responsive, failure, and reconnect qualification.
- Create `docs/operations/web-dashboard-runbook.md` and `docs/security/terminal-preview-threat-model.md`.

---

### Task 1: Freeze the Dashboard Security Contract

**Files:**
- Create: `docs/security/terminal-preview-threat-model.md`
- Modify: `site/tests/account-hub.test.mjs`
- Test: `site/tests/account-hub.test.mjs`

**Interfaces:**
- Consumes: existing `/account/`, `desktop_presence`, and account-scoped RLS.
- Produces: the exact forbidden-field contract used by all later tasks.

- [ ] **Step 1: Add the failing static contract test**

```js
const forbidden = [
  'raw_prompt',
  'prompt_body',
  'terminal_command',
  'working_directory',
  'filesystem_path',
  'plugin_credential',
  'api_key',
  'access_token',
  'refresh_token',
];
for (const field of forbidden) assert.doesNotMatch(presenceMigration, new RegExp(field, 'iu'));
assert.match(threatModel, /read-only/u);
assert.match(threatModel, /15 minutes/u);
assert.match(threatModel, /no remote command input/iu);
```

- [ ] **Step 2: Run the test and verify the missing threat model fails**

Run: `node --test site/tests/account-hub.test.mjs`

Expected: FAIL because `docs/security/terminal-preview-threat-model.md` and its invariants do not exist.

- [ ] **Step 3: Document assets, trust boundaries, abuse cases, and stop rules**

The document must define browser, Supabase, Worker, desktop, PTY, and provider trust boundaries; account-switch races; stolen/replayed tickets; malicious ANSI/control sequences; output floods; secret-like output; stale grants; disconnects; logging; and revocation. For every threat, name the exact preventative control and verification task below.

- [ ] **Step 4: Run the contract test**

Run: `node --test site/tests/account-hub.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- docs/security/terminal-preview-threat-model.md site/tests/account-hub.test.mjs
git commit -m "docs(security): define web terminal preview boundary"
```

---

### Task 2: Add Complete Web Authentication

**Files:**
- Create: `site/account/auth-model.mjs`
- Create: `site/account/auth-controller.js`
- Create: `site/tests/account-auth.test.mjs`
- Modify: `site/account/index.html`
- Modify: `site/account/account.js`
- Modify: `site/account/account.css`

**Interfaces:**
- Consumes: `createClient(...)`, Supabase `signUp`, `signInWithPassword`, `signInWithOtp`, `resetPasswordForEmail`, `verifyOtp`, `updateUser`, `getSession`, and `signOut`.
- Produces: `createAuthController({ client, elements, onAuthenticated })` and a six-digit state machine with `signin | signup | email-code | recovery-request | recovery-code | new-password`.

- [ ] **Step 1: Write failing model and DOM tests**

```js
assert.deepEqual(normalizeOtp(' 12a34-56 '), { ok: true, value: '123456' });
assert.equal(normalizeOtp('12345').ok, false);
assert.equal(normalizeOtp('1234567').ok, false);
assert.equal(validateSignup('owner@example.com', 'SecurePass9', 'SecurePass8').code, 'mismatch');
assert.match(html, /id="signup-form"/u);
assert.match(html, /id="recovery-form"/u);
assert.match(html, /id="new-password-form"/u);
```

Add race tests where mode switch, sign-out, or account replacement occurs while any Auth call is pending; the stale result must not render success or sign out a newer exact session.

- [ ] **Step 2: Run the auth tests**

Run: `node --test site/tests/account-auth.test.mjs`

Expected: FAIL because the modules and forms are absent.

- [ ] **Step 3: Implement exact flows**

```js
await client.auth.signUp({ email, password });
await client.auth.signInWithPassword({ email, password });
await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
await client.auth.resetPasswordForEmail(email);
await client.auth.verifyOtp({ email, token, type: verifyKind });
await client.auth.updateUser({ password: nextPassword });
```

Require matching password confirmation, normalized returned email, nonempty returned user ID, and an exact current-session ownership check before success. Consume password/code inputs immediately. Use generic account-enumeration-safe copy and 60-second resend cooldowns.

- [ ] **Step 4: Run account auth and existing account tests**

Run: `node --test site/tests/account-auth.test.mjs site/tests/account-hub.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- site/account site/tests/account-auth.test.mjs site/tests/account-hub.test.mjs
git commit -m "feat(web-auth): add signup and password recovery"
```

---

### Task 3: Publish Version-Two Safe Desktop Metadata

**Files:**
- Create: `supabase/migrations/0042_desktop_presence_v2.sql`
- Create: `app/src/features/access/desktopPresenceCollector.ts`
- Create: `app/src/features/access/desktopPresenceCollector.test.ts`
- Modify: `app/src/lib/supabase/desktopPresence.ts`
- Modify: `app/src/lib/supabase/desktopPresence.test.ts`
- Modify: `app/src/features/access/DesktopPresencePublisher.tsx`
- Modify: `app/src/features/access/DesktopPresencePublisher.test.tsx`

**Interfaces:**
- Produces:

```ts
interface PresenceProject {
  id: string;
  name: string;
  terminalCount: number;
  runningCount: number;
}
interface PresencePlugin {
  id: string;
  name: string;
  state: 'installed' | 'enabled' | 'disabled';
}
interface PresenceTerminal extends PresenceItemInput {
  projectId: string | null;
  shell: 'powershell' | 'cmd' | 'bash' | 'other';
  startedAt: string | null;
  lastOutputAt: string | null;
}
```

No command, output, cwd, path, prompt, plugin configuration, or credential field is allowed.

- [ ] **Step 1: Write sanitization, account-drift, and change-coalescing RED tests**

Assert 50-terminal, 50-project, 100-plugin bounds; exact nested keys; safe timestamps; unknown shell normalization; no publish after account drift; no unchanged publish inside five seconds; and a full publish by 20 seconds.

- [ ] **Step 2: Run focused tests**

Run: `npm --prefix app run test -- --run src/lib/supabase/desktopPresence.test.ts src/features/access/desktopPresenceCollector.test.ts src/features/access/DesktopPresencePublisher.test.tsx --maxWorkers=1`

Expected: FAIL on absent v2 fields and scheduler.

- [ ] **Step 3: Implement migration, collector, sanitization, and heartbeat**

The migration adds bounded `projects jsonb`, `plugins jsonb`, and `schema_version smallint`, validates every nested object key and value, and updates `publish_desktop_presence` atomically. The publisher hashes the sanitized snapshot, schedules changed data no faster than five seconds, and forces a 20-second heartbeat.

- [ ] **Step 4: Run tests and typecheck**

Run:

```powershell
npm --prefix app run test -- --run src/lib/supabase/desktopPresence.test.ts src/features/access/desktopPresenceCollector.test.ts src/features/access/DesktopPresencePublisher.test.tsx --maxWorkers=1
npm --prefix app run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- app/src/features/access app/src/lib/supabase/desktopPresence.ts app/src/lib/supabase/desktopPresence.test.ts supabase/migrations/0042_desktop_presence_v2.sql
git commit -m "feat(presence): publish safe live desktop metadata"
```

---

### Task 4: Add Private Realtime Dashboard State

**Files:**
- Create: `site/account/dashboard-realtime.js`
- Create: `site/tests/account-realtime.test.mjs`
- Modify: `supabase/migrations/0042_desktop_presence_v2.sql`
- Modify: `site/account/account.js`
- Modify: `site/account/account-model.mjs`

**Interfaces:**
- Produces: `startDashboardRealtime({ client, userId, onInvalidate, poll, now }) => () => void`.
- Topic: `account:<auth.uid()>:desktop-presence`, private only.

- [ ] **Step 1: Write RED tests for private subscription, reconnect, stale data, and fallback**

```js
assert.equal(channelConfig.private, true);
assert.equal(topic, `account:${userId}:desktop-presence`);
clock.advance(15_000);
assert.equal(pollCalls, 1);
controller.stop();
assert.equal(channelRemoved, true);
```

- [ ] **Step 2: Run tests**

Run: `node --test site/tests/account-realtime.test.mjs`

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement Broadcast trigger and client**

Use `realtime.broadcast_changes()` after insert/update/delete, a private-channel RLS policy keyed to the authenticated topic, a 250 ms invalidation coalescer, exponential reconnect capped at 30 seconds, and a 15-second poll only while disconnected. Mark presence stale after 45 seconds and offline after 60 seconds.

- [ ] **Step 4: Run tests**

Run: `node --test site/tests/account-realtime.test.mjs site/tests/account-hub.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- site/account/dashboard-realtime.js site/account/account.js site/account/account-model.mjs site/tests/account-realtime.test.mjs supabase/migrations/0042_desktop_presence_v2.sql
git commit -m "feat(web-dashboard): stream private desktop presence"
```

---

### Task 5: Build Overview, Usage, Billing, Project, and Plugin Views

**Files:**
- Create: `site/account/dashboard-data.js`
- Create: `site/account/dashboard-render.js`
- Modify: `site/account/index.html`
- Modify: `site/account/account.css`
- Modify: `site/account/account.js`
- Modify: `site/tests/account-hub.test.mjs`

**Interfaces:**
- Produces:

```js
loadDashboardData(client, exactUserId) => Promise<{
  profile, subscription, access, usage, devices
}>
renderDashboard(viewModel, root)
```

- [ ] **Step 1: Add failing view-model and rendering tests**

Cover active/trialing/grace/canceled/past-due/unavailable subscriptions, usage partial failure, device offline, uptime, projects, plugins, model/provider metadata, empty states, and account-switch invalidation. Assert rendering uses `textContent`, not payload-driven `innerHTML`.

- [ ] **Step 2: Run tests**

Run: `node --test site/tests/account-hub.test.mjs`

Expected: FAIL on absent tabs and normalized models.

- [ ] **Step 3: Implement the dashboard**

Tabs:

1. Overview: plan, Access, usage, online devices, running terminals, active jobs.
2. Usage: AI credits/tokens, voice minutes, SMS, per-provider/model metadata, source and freshness.
3. Billing: server-confirmed plan, renewal/cancellation, Checkout or Customer Portal action.
4. Devices: version, last seen, runtime, uptime, revoke.
5. Projects: safe project name, terminal/running counts, recent activity.
6. Plugins: installed/enabled/disabled names only; never configuration or credentials.
7. Terminals: metadata cards and opt-in preview action.

All degraded values say “Not confirmed” or “Temporarily unavailable”; redirects never grant success.

- [ ] **Step 4: Run tests**

Run: `node --test site/tests/account-hub.test.mjs site/tests/account-auth.test.mjs site/tests/account-realtime.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- site/account site/tests/account-hub.test.mjs
git commit -m "feat(web-dashboard): add usage billing and workspace views"
```

---

### Task 6: Create Short-Lived Terminal Preview Grants

**Files:**
- Create: `supabase/migrations/0043_terminal_preview_grants.sql`
- Create: `supabase/functions/create-terminal-preview-ticket/index.ts`
- Create: `supabase/functions/create-terminal-preview-ticket/index.test.ts`
- Create: `supabase/functions/revoke-terminal-preview/index.ts`
- Create: `supabase/functions/revoke-terminal-preview/index.test.ts`

**Interfaces:**
- Produces one-use tickets with `{ jti, sub, device_id, terminal_id, role, exp }`.
- Roles: `publisher | viewer`.
- Grant duration: 15 minutes; ticket duration: 60 seconds; one use.

- [ ] **Step 1: Write RED tests**

Cover missing/expired/wrong-account session, unknown/revoked/offline device, terminal absent from current presence, account drift, role mismatch, ticket replay, expiration, revocation, and constant-shape public errors.

- [ ] **Step 2: Run Edge Function tests**

Run:

```powershell
deno test --allow-env supabase/functions/create-terminal-preview-ticket/index.test.ts
deno test --allow-env supabase/functions/revoke-terminal-preview/index.test.ts
```

Expected: FAIL because functions and schema do not exist.

- [ ] **Step 3: Implement grants and ticket issuance**

Store only owner, device ID, terminal ID, grant timestamps, status, and hashed JTI. Never store output. Require `auth.uid()`, exact expected user, fresh device presence, current terminal membership, and an unreplayed JTI. Revoke all grants on device revocation or account sign-out.

- [ ] **Step 4: Run tests**

Run the two Deno commands from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- supabase/migrations/0043_terminal_preview_grants.sql supabase/functions/create-terminal-preview-ticket supabase/functions/revoke-terminal-preview
git commit -m "feat(security): add terminal preview grants"
```

---

### Task 7: Build the Isolated Cloudflare Terminal Relay

**Files:**
- Create: `workers/dashboard-relay/package.json`
- Create: `workers/dashboard-relay/wrangler.jsonc`
- Create: `workers/dashboard-relay/src/index.ts`
- Create: `workers/dashboard-relay/src/TerminalPreviewRoom.ts`
- Create: `workers/dashboard-relay/src/auth.ts`
- Create: `workers/dashboard-relay/src/protocol.ts`
- Create: `workers/dashboard-relay/test/relay.test.ts`
- Create: `workers/dashboard-relay/README.md`

**Interfaces:**
- Publisher sends `{ type: 'output', seq, at, data }`.
- Viewer receives sanitized output and `{ type: 'state', status, at }`.
- No message type accepts command text, input bytes, resize, file request, prompt request, or tool invocation.

- [ ] **Step 1: Write protocol and integration RED tests**

Test exact-key schemas, ticket signature/issuer/audience/expiry/JTI, publisher-viewer binding, replay rejection, 16 KiB frames, 256 KiB ring truncation, monotonic sequence, flood close, role enforcement, account isolation, hibernation attachment recovery, revocation, and absence of output from logs/storage.

- [ ] **Step 2: Run Worker tests**

Run: `npm --prefix workers/dashboard-relay test`

Expected: FAIL because the package is absent.

- [ ] **Step 3: Implement the Worker and Durable Object**

Use SQLite-backed DO configuration only for namespace compatibility; do not write terminal content to storage. Use the Hibernation WebSocket API, serialized attachments containing only bounded IDs/role/expiry, 100 ms batching, close codes for expired/revoked/overflow sessions, and metadata-only analytics.

- [ ] **Step 4: Run tests and typecheck**

Run:

```powershell
npm --prefix workers/dashboard-relay test
npm --prefix workers/dashboard-relay run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- workers/dashboard-relay
git commit -m "feat(relay): add read-only terminal preview rooms"
```

---

### Task 8: Connect Desktop Terminal Output Safely

**Files:**
- Create: `app/src/features/terminals/terminalPreviewGrantStore.ts`
- Create: `app/src/features/terminals/terminalPreviewGrantStore.test.ts`
- Create: `app/src/features/terminals/terminalPreviewSanitizer.ts`
- Create: `app/src/features/terminals/terminalPreviewSanitizer.test.ts`
- Create: `app/src/features/terminals/terminalPreviewRelay.ts`
- Create: `app/src/features/terminals/terminalPreviewRelay.test.ts`
- Modify: exact existing terminal output-router file identified by `rg -n "appendOutput|route.*output|onData" app/src/features/terminals`.

**Interfaces:**
- Produces `publishTerminalPreviewChunk(accountId, terminalId, bytes)` and `revokeAllPreviewGrants(reason)`.

- [ ] **Step 1: Write RED tests**

Cover no grant/no network, exact account/device/terminal match, account switch, terminal close, app lock, sign-out, grant expiry, invalid UTF-8, ANSI/OSC/DCS/APC stripping, control characters, URL/userinfo/token-like redaction, batching, buffer cap, reconnect with a fresh ticket, and zero interference with normal terminal rendering.

- [ ] **Step 2: Run tests**

Run: `npm --prefix app run test -- --run src/features/terminals/terminalPreviewGrantStore.test.ts src/features/terminals/terminalPreviewSanitizer.test.ts src/features/terminals/terminalPreviewRelay.test.ts --maxWorkers=1`

Expected: FAIL because the modules are absent.

- [ ] **Step 3: Implement outbound-only publishing**

The existing terminal renderer remains authoritative. Duplicate only already-accepted output after local rendering, sanitize it, then enqueue it when an exact active grant exists. Never intercept input, spawn, resize, environment, cwd, process command line, or scrollback history. A relay failure only stops preview and must not affect the PTY.

- [ ] **Step 4: Run focused terminal and type gates**

Run:

```powershell
npm --prefix app run test -- --run src/features/terminals/terminalPreviewGrantStore.test.ts src/features/terminals/terminalPreviewSanitizer.test.ts src/features/terminals/terminalPreviewRelay.test.ts src/features/terminals/TerminalView.execution.test.tsx --maxWorkers=1
npm --prefix app run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- app/src/features/terminals
git commit -m "feat(terminal): publish approved read-only previews"
```

---

### Task 9: Add the Web Terminal Preview UI

**Files:**
- Create: `site/account/terminal-preview.js`
- Create: `site/tests/terminal-preview.test.mjs`
- Modify: `site/account/index.html`
- Modify: `site/account/account.css`
- Modify: `site/account/dashboard-render.js`

**Interfaces:**
- Consumes authenticated viewer tickets and relay frames.
- Produces an accessible read-only terminal region and explicit Start/Stop controls.

- [ ] **Step 1: Write UI RED tests**

Test explicit consent text, 15-minute expiry, no auto-connect, no input element, no paste/keyboard forwarding, bounded ring, pause when hidden, reconnect with fresh ticket, account-switch teardown, stop/revoke, expiry, offline, and reduced motion.

- [ ] **Step 2: Run tests**

Run: `node --test site/tests/terminal-preview.test.mjs`

Expected: FAIL because the module and controls are absent.

- [ ] **Step 3: Implement the preview**

The Start action explains exactly what is shared and requests a viewer ticket. Render text safely in a `role="log"` region, follow output only when the user has not scrolled upward, show bytes retained and expiry countdown, and provide a persistent Stop sharing action. Do not cache output in IndexedDB, localStorage, sessionStorage, Cache API, or service workers.

- [ ] **Step 4: Run website tests**

Run: `node --test site/tests/account-hub.test.mjs site/tests/account-auth.test.mjs site/tests/account-realtime.test.mjs site/tests/terminal-preview.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- site/account site/tests/terminal-preview.test.mjs
git commit -m "feat(web-dashboard): add opt-in terminal previews"
```

---

### Task 10: Add Observability, Rate Limits, and Failure Guardrails

**Files:**
- Create: `docs/operations/web-dashboard-runbook.md`
- Modify: `workers/dashboard-relay/src/index.ts`
- Modify: `workers/dashboard-relay/src/TerminalPreviewRoom.ts`
- Modify: `site/account/dashboard-realtime.js`
- Modify: `app/src/features/access/DesktopPresencePublisher.tsx`
- Modify: related tests.

**Interfaces:**
- Produces content-free metrics: auth result class, realtime state, device count, preview session count, bytes bucket, close reason, latency bucket, and error class.

- [ ] **Step 1: Add failing fault tests**

Inject Supabase timeout/429/5xx, Realtime disconnect, Worker restart, ticket service failure, publisher loss, viewer loss, output flood, clock skew, offline transition, and stale device. Assert bounded retries with jitter, no loops, no raw errors/content in logs, and truthful degraded UI.

- [ ] **Step 2: Run all focused fault suites**

Run the website, app terminal/presence, Edge Function, and Worker commands from Tasks 3, 4, 6, 7, 8, and 9.

Expected: FAIL on missing metrics and backoff controls.

- [ ] **Step 3: Implement guardrails**

Use maximum reconnect delays of 30 seconds, maximum five attempts before manual Retry, circuit-open UI after repeated failure, per-user/device connection caps, per-session byte/message budgets, `Retry-After` handling, health endpoints without customer data, and alerts for auth failures, repeated ticket replay, relay overflow, and billing webhook lag.

- [ ] **Step 4: Re-run fault suites**

Expected: PASS with no unhandled rejection, reconnect storm, raw payload log, or terminal interruption.

- [ ] **Step 5: Commit**

```powershell
git add -- docs/operations/web-dashboard-runbook.md workers/dashboard-relay site/account app/src/features/access app/src/features/terminals
git commit -m "feat(reliability): harden live dashboard failure handling"
```

---

### Task 11: Production Email, Billing, and Configuration Readiness

**Files:**
- Modify: `.env.example`
- Modify: `workers/vibespace-mcp/src/index.ts`
- Modify: `workers/vibespace-mcp/test/worker.test.ts`
- Modify: `docs/operations/web-dashboard-runbook.md`
- Create: `docs/operations/web-dashboard-launch-checklist.md`

**Interfaces:**
- Public config returns only HTTPS Supabase URL, publishable key, dashboard relay origin, and bounded release version.

- [ ] **Step 1: Add configuration RED tests**

Reject legacy anonymous-key-only config for new deployments, non-HTTPS origins, wildcard credentialed CORS, missing SMTP readiness, missing Stripe price/webhook configuration, and missing relay signing keys. Assert secret-shaped fields are never returned.

- [ ] **Step 2: Run gateway tests**

Run: `npm --prefix workers/vibespace-mcp test -- --run test/worker.test.ts`

Expected: FAIL on missing dashboard relay configuration contract.

- [ ] **Step 3: Document and implement configuration checks**

Required production services:

- Supabase project with Auth, RLS migrations, Realtime private channels, Edge Functions, and custom SMTP.
- Stripe secret/webhook and the existing Access/add-on price IDs.
- Cloudflare dashboard relay with ticket verification keys and a dedicated allowed-origin list.
- `vibespaceos.com` and `www.vibespaceos.com` exact redirect/CORS origins.

Cost baseline checked 2026-08-10: Cloudflare Workers Paid has a $5/month minimum and includes Durable Object allowances; Supabase/custom SMTP/Stripe costs depend on the existing plan, mail vendor, message volume, and transactions. Do not fund AI provider balances for this dashboard because it does not call models.

- [ ] **Step 4: Run config tests**

Run: `npm --prefix workers/vibespace-mcp test -- --run test/worker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- .env.example workers/vibespace-mcp/src/index.ts workers/vibespace-mcp/test/worker.test.ts docs/operations
git commit -m "docs(operations): add dashboard production configuration"
```

---

### Task 12: Browser, Accessibility, Performance, and Deployment Qualification

**Files:**
- Create: `qa/dashboard/account-dashboard.spec.ts`
- Modify: `.github/workflows/pages.yml`
- Modify: `site/tests/account-hub.test.mjs`
- Modify: `docs/operations/web-dashboard-launch-checklist.md`

**Interfaces:**
- Produces the final release evidence bundle and rollback decision.

- [ ] **Step 1: Build end-to-end tests**

Cover sign-up, password sign-in, email OTP, recovery wrong/correct code, controlled account switch, overview, billing redirect truth, usage partial failure, private realtime update, polling fallback, devices/projects/plugins, preview grant/start/stream/stop/expiry, offline desktop, mobile/desktop widths, keyboard flow, screen-reader names, reduced motion, and no horizontal overflow.

- [ ] **Step 2: Run the full automated gate**

Run:

```powershell
node --test site/tests/*.test.mjs
npm --prefix app run typecheck
npm --prefix app run test -- --run src/lib/supabase/desktopPresence.test.ts src/features/access/DesktopPresencePublisher.test.tsx src/features/terminals/terminalPreviewGrantStore.test.ts src/features/terminals/terminalPreviewSanitizer.test.ts src/features/terminals/terminalPreviewRelay.test.ts --maxWorkers=1
npm --prefix workers/dashboard-relay test
npm --prefix workers/dashboard-relay run typecheck
deno test --allow-env supabase/functions/create-terminal-preview-ticket/index.test.ts
deno test --allow-env supabase/functions/revoke-terminal-preview/index.test.ts
npx playwright test qa/dashboard/account-dashboard.spec.ts
git diff --check
```

Expected: every command PASS; browser console has zero uncaught errors; axe has zero serious/critical issues.

- [ ] **Step 3: Run a staging soak**

Use disposable accounts/devices/terminals only. Run 24 hours with device reconnects, 100 preview start/stop cycles, account switching, terminal output floods within the test budget, Stripe test-mode checkout/portal/webhook, SMTP delivery, and Worker/Supabase fault injection. Required results: zero cross-account data, zero remote input, zero persisted output, zero reconnect loops, preview p95 under two seconds, metadata p95 under five seconds, and no desktop terminal lag regression.

- [ ] **Step 4: Deploy in ordered stages**

1. Apply migrations.
2. Deploy Edge Functions.
3. Deploy the dashboard relay with preview disabled.
4. Deploy the website dashboard.
5. Release desktop metadata v2.
6. Enable internal preview accounts.
7. Expand to 5%, 25%, 100% only after 24-hour gates.

Rollback disables preview ticket issuance first, then restores the previous website account bundle. Metadata v1 remains readable throughout.

- [ ] **Step 5: Commit**

```powershell
git add -- qa/dashboard .github/workflows/pages.yml site/tests docs/operations/web-dashboard-launch-checklist.md
git commit -m "test(web-dashboard): add production release qualification"
```

---

## Acceptance Milestones

### Milestone A — Account and billing hub

- Sign-up, password sign-in, email-code sign-in, password recovery, new password, and sign-out work with exact six-digit code validation.
- Account enumeration is not exposed.
- Plan, Access, billing, and usage are server-authoritative.

### Milestone B — Live workspace metadata

- Device, terminal, project, plugin, agent-job, provider/model, uptime, and status metadata update in under five seconds while active.
- Realtime failure automatically falls back to bounded polling.
- No sensitive desktop data appears in presence payloads.

### Milestone C — Opt-in terminal preview

- A user explicitly grants one terminal for 15 minutes.
- Output is read-only, sanitized, memory bounded, not persisted, revocable, and account/device/terminal bound.
- Terminal rendering and PTY performance are unaffected when preview is off or the relay fails.

### Milestone D — Production readiness

- Custom SMTP, Stripe webhooks, Supabase RLS/Realtime, and Cloudflare relay are configured and monitored.
- Full automated gates, staging soak, accessibility, responsive, security, failure, and rollback tests pass.
- Remote terminal input, raw prompts, file access, credentials, and indefinite terminal logs remain out of scope.

## Primary Platform References Checked 2026-08-10

- Supabase password Auth: https://supabase.com/docs/guides/auth/passwords
- Supabase email templates and six-digit OTP: https://supabase.com/docs/guides/auth/auth-email-templates
- Supabase Auth rate limits: https://supabase.com/docs/guides/auth/rate-limits
- Supabase custom SMTP: https://supabase.com/docs/guides/auth/auth-smtp
- Supabase private Realtime Broadcast: https://supabase.com/docs/guides/realtime/broadcast
- Supabase database-change guidance: https://supabase.com/docs/guides/realtime/subscribing-to-database-changes
- Cloudflare Durable Object WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Cloudflare Durable Object limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
