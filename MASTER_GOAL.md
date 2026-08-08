# VibeSPACE PR #31 — Full-System Release Proof, Stability, Security, Billing, and Product Completion Master Goal

**Goal ID:** `VS-PR31-FULL-SYSTEM-RELEASE-PROOF-20260805`  
**Repository:** `Cookie774-GameDev/VibeSpace`  
**Only target branch:** `agent/pr30-fixes-and-updates`  
**Only target pull request:** `#31`  
**Execution owner:** one primary implementation agent  
**Subagents:** **PROHIBITED**  
**Status:** owner-directed master execution contract  
**Priority:** release-blocking correctness, crash resistance, security, billing integrity, performance, and truthful product behavior  
**Execution mode:** inspect once, plan briefly, implement in focused slices, verify continuously, commit only proven work to PR #31

---

## 1. Mission

Perform a full, evidence-driven audit and proof-fix of the VibeSPACE desktop application, its local runtimes, Tauri/Rust bridge, React frontend, persistence layer, Supabase backend, Stripe billing system, provider connections, plugins/MCP gateway, phone/voice systems, Build Your Own AI workflow, browser/workbench, pet overlay, Command Center, terminals, context systems, release packaging, and every directly connected production surface.

The release target is:

- maximum practical quality;
- maximum practical performance;
- no known release-blocking crashes;
- no dead controls;
- no fake or mock production state;
- no false “connected,” “ready,” “downloaded,” “trained,” “verified,” “best for your PC,” or “working” labels;
- no secrets shipped to the client;
- no silent billing corruption;
- no destructive action without the required approval;
- no unrelated redesign;
- no broken existing functionality;
- bounded, graceful recovery whenever an external provider, local runtime, worker, database, network, file decoder, or operating-system capability fails.

This goal is not permission to rewrite the entire product from scratch. Build on the existing architecture and feature modules. Prefer small, reversible, well-tested corrections over broad refactors. Preserve every working feature and the current visual language unless this document explicitly authorizes a visual or wording adjustment.

This file supersedes earlier broad PR #31 execution prompts where they conflict, but it does **not** delete, weaken, or rewrite prior owner-approved documents. Earlier specifications remain supporting references.

---

## 2. Non-negotiable operating rules

### 2.1 One agent only

Do not start, invoke, delegate to, or coordinate autonomous subagents.

This specifically means:

- do not use the repository’s subagent lifecycle feature for implementation;
- do not launch secondary coding agents;
- do not fan work out to other model instances;
- do not create parallel autonomous worktrees;
- do not claim another agent verified a result.

Normal deterministic tools are allowed: compiler, test runner, formatter, package manager, database CLI, Stripe CLI, Supabase CLI, browser/devtools, performance profiler, security scanner, operating-system commands, and Git.

### 2.2 PR #31 only

All edits, commits, test evidence, and documentation from this goal must land only on:

```text
agent/pr30-fixes-and-updates
```

Do not modify another branch. Do not create a replacement PR. Do not merge PR #31. Do not publish a release. Do not enable production billing. Do not deploy production migrations or production secrets unless the owner separately authorizes that exact action.

Before every write:

1. confirm repository identity;
2. confirm branch identity;
3. inspect the latest PR #31 head;
4. reconcile any newer commits;
5. avoid overwriting unrelated in-progress work.

### 2.3 Fast planning, deep execution

Create one compact execution ledger before implementation. Do not spend hours writing more planning documents.

The ledger must contain:

- slice ID;
- affected feature;
- exact paths;
- risk level;
- reproduction or audit evidence;
- intended correction;
- focused tests;
- status;
- blockers;
- commit SHA.

Then begin P0 work immediately.

### 2.4 No unrelated changes

Do not:

- mass-format the repository;
- rename broad public APIs without necessity;
- move whole directory trees merely for cleanliness;
- change branding, layout, navigation, spacing, typography, or theme outside an explicitly requested surface;
- replace proven dependencies without evidence;
- remove functioning fallbacks;
- delete owner-approved documents;
- edit website-only files unless a required desktop flow truly depends on them;
- “simplify” by removing a promised feature.

### 2.5 Truth over appearance

Every user-visible state must come from verified runtime truth.

Examples:

- executable detected is not the same as authenticated;
- authenticated is not the same as healthy;
- downloaded is not the same as checksum verified;
- selected is not the same as loadable;
- a file accepted is not the same as processed;
- a training job queued is not the same as training;
- a training job completed is not the same as a usable artifact;
- a Stripe Checkout redirect is not the same as an entitlement;
- a webhook received is not the same as processed;
- a plugin listed is not the same as authorized;
- a model shown is not necessarily compatible;
- an iframe timeout is not proof a website is down.

Remove production-facing `mock default`, fake progress, placeholder balances, fabricated device results, dummy provider usage, simulated success, and unverified “ready” badges. Development fixtures may remain only behind explicit test/dev boundaries and must be impossible to confuse with production state.

---

## 3. Reality constraints the implementation must respect

### 3.1 “Never crash”

No software can be honestly guaranteed to never crash under every workload, driver, device, corrupted file, provider outage, or operating-system condition.

The engineering target is therefore:

- zero known reproducible release-blocking crashes;
- zero known unhandled promise rejections in supported flows;
- no UI thread starvation from expected heavy work;
- no single subsystem failure that terminates or whites out the entire app;
- automatic restoration or a clear recovery action after bounded failures;
- crash diagnostics that redact secrets and user content;
- measured crash-free-session targets in release candidates;
- release blocked when a P0 crash remains reproducible.

Do not write “crash-proof” or “cannot crash” in the final evidence. Write what was actually tested.

### 3.2 Supabase Free

The owner intends to remain on Supabase Free for now. Optimize for that constraint, but do not claim unlimited capacity, an SLA, automatic backups, or guaranteed support for thousands of simultaneous users.

At execution time, verify the **current** official Free plan limits. Build:

- a measured capacity report;
- a quota budget;
- graceful degradation;
- retention and cleanup policies;
- database indexes and query budgets;
- an export/backup procedure;
- alerts or owner-visible health checks;
- explicit upgrade thresholds.

The product may launch to thousands of registered users only when measured active-use patterns remain inside the verified free-tier envelope. “Thousands of accounts” and “thousands of concurrent users” are not the same claim.

### 3.3 Stripe

Stripe integration does not require a custom monthly software subscription merely to call the API, but Stripe payment and Billing fees still apply. Do not describe Stripe as cost-free.

Use test mode first. Live mode remains owner-gated.

### 3.4 Embedded websites

Websites can legally and technically refuse iframe embedding through `X-Frame-Options` or CSP `frame-ancestors`. Do not strip, proxy around, forge, or bypass those protections.

For full browser behavior, use a secure native Tauri webview/browser-window architecture or open the system browser. Never inject privileged Tauri APIs into untrusted remote pages.

### 3.5 Antivirus and SmartScreen

No implementation can guarantee that a new Windows binary will never receive a reputation warning.

Reduce risk through:

- consistent Authenticode signing identity;
- signed updater artifacts;
- clean installer behavior;
- stable publisher metadata;
- no bundled secrets;
- no suspicious persistence, injection, browser credential scraping, or hidden process behavior;
- malware and PUA scans;
- dependency and SBOM review;
- optional Microsoft Store distribution;
- reputation-monitoring and false-positive response procedure.

Do not attempt to disable Windows security controls.

---

## 4. Source-of-truth hierarchy

When requirements conflict, use this order:

1. this `MASTER_GOAL.md`;
2. the owner-approved billing/provider handoff dated 2026-07-23;
3. `AGENTS.md`;
4. existing PR #31 goal/design/skill documents;
5. current production code and tests;
6. older comments, constants, screenshots, and placeholders.

The owner-approved billing/provider handoff is a product contract, not permission to deploy blindly. Preserve its commercial model, shared-credit rules, provider direction, Stripe test-catalog contract, Supabase target contract, migration requirements, and launch gates.

Do not delete that handoff merely because old constants disagree.

---

## 5. Severity and release policy

### P0 — release blocked

Examples:

- app white-screen, frozen, or “not responding”;
- data loss or corrupted persistence;
- Stripe entitlement or credit corruption;
- unauthenticated data access;
- exposed secret;
- arbitrary command execution, path traversal, SSRF, unsafe remote webview bridge, or updater compromise;
- local training action crashes the app;
- provider selection silently routes to another paid provider;
- pet/overlay process prevents normal app recovery;
- destructive operation occurs without required confirmation;
- signed webhook verification missing or bypassable;
- release installer/updater cannot be verified.

### P1 — must fix before broad launch

Examples:

- dead provider/plugin controls;
- false hardware/model readiness;
- unusable Build Your Own AI flow;
- broken history/project persistence;
- task usage module invisible while enabled;
- unsupported attachment types promised as supported;
- voice/calling/notifications not completing real flows;
- major lag or memory growth;
- important page cannot scroll;
- inaccessible critical actions;
- stale assistant name such as `Ask Friday` when Jarvis is selected.

### P2 — polish after functional proof

Examples:

- targeted wording;
- requested glass treatment;
- agent emoji;
- animation pacing;
- non-blocking visual refinements;
- additional preloaded avatar choices;
- richer context-map effects.

If a P0 cannot be fixed, record the root cause, exact reproduction, attempts, evidence, and next required action; continue independent work, but keep the release blocked. Do not hide the blocker.

---

## 6. Efficient execution sequence

### Phase 0 — baseline and safety map

1. Read `AGENTS.md`, this file, the billing/provider handoff, current PR description, current CI, release scripts, Supabase README, and existing production-functionality goal.
2. Record current PR head.
3. Build a feature/path map using the existing modules rather than guessing.
4. Run secret scans before changing code.
5. Capture baseline:
   - cold launch;
   - warm launch;
   - settings-open latency;
   - chat-open latency;
   - idle CPU;
   - idle memory;
   - active local chat memory;
   - Build Your Own AI page latency;
   - Command Center latency;
   - Workbench browser behavior;
   - task usage module visibility;
   - current crash reproductions.
6. Reproduce exact reported failures where possible.
7. Record environment limitations honestly.

### Phase 1 — P0 crash containment

Fix app-level white-screen/not-responding failures, missing Tauri invoke access, kernel-host availability, training-worker crashes, UI-thread blocking, unhandled async errors, listener leaks, runaway polling, and persistence corruption first.

### Phase 2 — billing, data, and security authority

Audit and correct Stripe, Supabase, entitlements, shared credits, RLS, migrations, webhook processing, secrets, provider billing, and high-risk authorization boundaries.

### Phase 3 — provider, plugin, MCP, and browser connectivity

Fix real connection flows, health states, OAuth/deep-link callbacks, multi-account plugin routing, model discovery, MCP permissions, ChatGPT/Codex bridge truth, and native browser behavior.

### Phase 4 — Build Your Own AI and local runtime

Complete hardware detection, worker lifecycle, ingestion, RAG versus fine-tuning truth, model selection, training jobs, artifact management, custom-model routing, and resumable background execution.

### Phase 5 — product systems and requested UI corrections

Complete pet overlay, Command Center, terminals, tools, attachments, history/projects, avatars, context map, voice/phone, task usage bar, token settings, intro animation, scrolling, and named visual changes.

### Phase 6 — performance, resilience, packaging, and security proof

Run targeted load tests, fault injection, installer/updater checks, code signing checks, AV scans, dependency review, SBOM generation, and performance comparison.

### Phase 7 — release candidate evidence

Run final coherent gates, create an honest unresolved-blocker list, document required owner inputs, and leave PR #31 as a draft unless separately instructed.

---

# PART I — APPLICATION STABILITY, CRASH RESISTANCE, AND PERFORMANCE

## 7. Whole-app crash containment

Audit the startup and runtime ownership graph:

- `App.tsx`;
- root providers;
- routing;
- kernel host;
- assistant execution host;
- Tauri/native capability host;
- persistence coordinator;
- global event subscriptions;
- local runtime host;
- terminal host;
- voice host;
- pet/overlay host;
- updater host;
- background job host.

### Required corrections

1. Add or verify layered React error boundaries:
   - root shell boundary;
   - route/feature boundary;
   - heavy native feature boundary;
   - plugin/provider boundary;
   - custom model/training boundary.
2. A feature error must render a bounded recovery surface, not a full white app.
3. Capture unhandled promise rejections and window errors without logging secrets or private content.
4. Every long-running operation must support:
   - cancellation;
   - bounded timeout;
   - progress from real events;
   - cleanup in `finally`;
   - retry policy where safe;
   - idempotency where repeated.
5. Every event listener, timer, stream, observer, process, and Tauri subscription must be removed when no longer used.
6. One provider failure must never crash:
   - settings;
   - model selector;
   - chat composer;
   - usage bar;
   - Command Center;
   - plugin catalog;
   - pet panel.
7. Heavy work must not run synchronously on the React UI thread.
8. Blocking Rust work must use safe background execution and avoid blocking Tauri’s main event loop.
9. File parsing, media extraction, hashing, model verification, hardware scanning, and training must run in bounded workers/processes.
10. Add watchdog health state for optional sidecars without creating an aggressive restart loop.
11. Apply exponential backoff with jitter and a maximum retry ceiling.
12. Persist enough state to recover from app restart, but do not replay unsafe external actions automatically.

### Exact reported crash symptoms to reproduce

- VibeSPACE becomes white/faded and Windows says “not responding.”
- Build Your Own AI training runtime remains “setting up” and then the app crashes.
- Build Your Own AI page is extremely laggy.
- Page Builder/AI pages become unresponsive.
- `Cannot read properties of undefined (reading 'invoke')`.
- `Canonical JARVIS kernel authority is unavailable in this window.`

For each exact symptom:

1. create a focused reproduction;
2. identify whether it is browser-mode misuse, host initialization ordering, missing provider, stale window authority, blocked IPC, synchronous work, or an actual exception;
3. fix the authority/lifecycle contract;
4. add regression coverage;
5. verify in the installed Tauri app, not only Vite browser mode.

Browser mode may show an explicit “desktop capability unavailable” state. It must not throw because `window.__TAURI__`, an invoke function, or a kernel authority is absent.

---

## 8. Performance engineering

### Required measurements

Record before and after on a representative low-memory Windows device and a stronger Windows device:

- process count;
- installer size;
- cold launch to usable shell;
- warm launch;
- first route change;
- settings open;
- model selector open;
- Command Center open;
- Build Your Own AI open;
- Workbench open;
- Context Map open;
- local-model first token;
- cloud-model first token excluding provider latency;
- idle CPU;
- idle RAM;
- 30-minute idle memory drift;
- 30-minute streaming-chat memory drift;
- terminal memory per active pane;
- pet-only tray mode memory;
- task usage module overhead;
- graph interaction frame time;
- drag-and-drop attachment response.

### Required optimization pass

- Remove duplicate polling loops.
- Deduplicate provider health requests.
- Pause timers when windows/features are hidden or disabled.
- Use narrow Zustand selectors rather than broad store subscriptions.
- Avoid rerendering the app shell for streaming token updates.
- Batch high-frequency usage and progress events.
- Virtualize large histories, model lists, files, logs, and plugin catalogs.
- Lazy-load Pixi/graph/training/browser-heavy code.
- Keep native-only imports out of initial browser bundles.
- Use Web Workers or native workers for parsing and hashing.
- Avoid copying very large buffers between JS and Rust unnecessarily.
- Stream files rather than loading all bytes into memory.
- Bound logs and terminal scrollback.
- Cache static model/provider manifests with versioned invalidation.
- Use database pagination and keyset pagination where appropriate.
- Ensure all animations stop when hidden and respect reduced motion.
- Audit images/video for decode size, dimensions, and startup impact.
- Remove accidental production source maps if release policy disallows them, while preserving secure symbolication separately.
- Do not optimize by removing correctness, accessibility, security, or cancellation.

### Performance release budgets

Set evidence-based budgets after baseline. At minimum, define and enforce:

- no expected user action blocks the UI thread for more than 100 ms without yielding;
- no spinner can remain indefinite without status/timeout;
- no hidden disabled feature keeps active polling;
- no unbounded queue, collection, log, history, or event buffer;
- no multi-minute synchronous initialization;
- no permanent memory growth from repeatedly opening/closing a page;
- no Build Your Own AI operation runs inside the rendering process when it can be isolated.

---

# PART II — SECURITY, PRIVACY, AND RELEASE INTEGRITY

## 9. Threat model and attack-surface audit

Create a concise threat model covering:

- untrusted chat text;
- prompt injection through files and websites;
- untrusted HTML/video/document ingestion;
- plugins and MCP tools;
- terminal execution;
- local file access;
- remote browser pages;
- OAuth callbacks;
- provider API keys;
- Supabase sessions;
- Stripe webhooks;
- phone/SMS webhooks;
- updater manifests;
- model downloads;
- custom executables;
- local sidecars;
- pet overlay windows;
- logs and diagnostics.

### Required controls

- Validate every IPC argument in Rust.
- Use allowlisted Tauri commands and capabilities.
- Deny privileged Tauri bridge access in untrusted remote webviews.
- Canonicalize and validate file paths.
- Prevent traversal outside owner-approved roots.
- Validate URL schemes and destinations.
- Prevent SSRF to loopback, metadata, local network, or unsupported protocols where a cloud function fetches URLs.
- Sanitize rendered HTML and Markdown.
- Do not execute content from attachments.
- Use MIME sniffing plus extension checks.
- Sandbox decoders and external conversion tools.
- Require explicit approval before destructive or external actions.
- Escape shell arguments; do not build unsafe shell strings.
- Distinguish command, executable path, working directory, and prompt.
- Redact secrets from logs and errors.
- Apply rate limits and abuse limits to hosted functions.
- Preserve RLS.
- Keep service-role keys only server-side.
- Rotate compromised credentials.
- Reject unsigned or invalid updater manifests.
- Verify model/artifact hashes and signatures where available.

### Dependency and supply-chain proof

- Review npm and Cargo dependency advisories.
- Review direct dependencies for necessity.
- Generate an SBOM for the release candidate.
- Record licenses.
- Verify downloaded binaries/models originate from approved sources.
- Pin hashes/versions for sidecars.
- Do not download and execute arbitrary GitHub release assets based only on a mutable tag.
- Preserve the repository’s source-credit document and add missing attribution.
- Do not copy code from an incompatible license.
- Use only the minimum code required from external repositories.

---

## 10. Secrets and configuration

### Absolute rules

- Never commit a real secret.
- Never place company secrets in `VITE_*`.
- Never ship Stripe secret keys, webhook secrets, Supabase service-role keys, Telnyx keys, Deepgram keys, DeepSeek company keys, OAuth client secrets, or updater private keys inside the desktop bundle.
- BYOK secrets entered in the app must use the approved secure credential store.
- Do not print tokens in terminal output, console, screenshots, telemetry, or test snapshots.
- Public identifiers such as Supabase URL, publishable anon key, OAuth client ID, Stripe Price ID, and public verification keys must still be treated deliberately and documented.

Audit `.env.example` against the final provider architecture. Remove stale Twilio/server variables only after the coordinated Telnyx migration is complete; until then, mark legacy variables clearly and prevent ambiguous dual routing.

Create a generated configuration diagnostic that reports:

- present/missing;
- client/server scope;
- environment;
- source;
- last validation;
- redacted identifier;
- required next action.

It must never reveal the value.

---

## 11. Windows installer, signing, updater, and malware reputation

### Required release path

- Verify NSIS/MSI packaging configuration.
- Verify WebView2 strategy.
- Sign application binaries and installer with the approved certificate.
- Use one stable publisher identity.
- Sign updater artifacts and verify signatures before installation.
- Verify release manifest version consistency.
- Verify rollback.
- Verify install, update, repair, uninstall, and clean reinstall.
- Verify app opens with no development server.
- Verify no localhost dependency exists in production.
- Scan release artifacts with multiple reputable scanners.
- Record hashes.
- Review bundled sidecars and their licenses.
- Verify no hidden persistence beyond documented tray/startup settings.
- Verify startup entry is opt-in or clearly disclosed.
- Verify closing/minimizing behavior matches settings.
- Prepare a false-positive reporting process.
- Evaluate Microsoft Store distribution as a reputation-improving option.
- Do not claim “will never be marked as malware.”

---

# PART III — BILLING, STRIPE, SUPABASE, AND SHARED CREDITS

## 12. Canonical commercial contract

Implement and verify the owner-approved package model exactly:

| Package | Access | Add-on | Total | Monthly shared credits | Provider budget |
|---|---:|---:|---:|---:|---:|
| Spark | $20 | $0 | $20 | 1,000 | $1.00 |
| Orbit | $20 | $10 | $30 | 5,500 | $5.50 |
| Nova | $20 | $50 | $70 | 27,500 | $27.50 |
| Singularity | $20 | $100 | $120 | 55,000 | $55.00 |
| Supernova | $20 | $200 | $220 | 110,000 | $110.00 |

Canonical rule:

```text
1 shared credit = $0.001 of actual company-paid provider usage
```

For paid add-ons:

```text
monthly credits = add-on price × 55% × 1,000
```

Spark is the approved exception and includes 1,000 credits.

### Shared-pool behavior

The same balance may fund approved company-hosted:

- DeepSeek hosted chat/agent inference;
- Telnyx phone transport;
- Telnyx SMS segments/carrier fees;
- Deepgram Flux STT;
- Deepgram Aura TTS;
- optional Telnyx Inworld Mini TTS after quality approval.

Required accounting:

1. reserve conservatively before provider work;
2. settle against actual cost;
3. release unused reservation;
4. record per-service analytics;
5. keep one fungible shared pool;
6. no rollover;
7. no cash value;
8. no transfer;
9. no automatic overage;
10. exhausted state falls back honestly to BYOK/local or blocks the hosted action.

The following must bypass company credits:

- local Kokoro;
- Ollama/local models;
- operating-system/browser speech fallback;
- customer BYOK calls.

---

## 13. Stripe architecture

### Test catalog

Create and verify in Stripe **test mode** first:

| Product | Monthly price | Lookup key | Component |
|---|---:|---|---|
| VibeSPACE Access / Spark | $20 | `vibespace_access_monthly_v1` | access |
| Orbit Add-on | $10 | `vibespace_orbit_addon_monthly_v1` | addon |
| Nova Add-on | $50 | `vibespace_nova_addon_monthly_v1` | addon |
| Singularity Add-on | $100 | `vibespace_singularity_addon_monthly_v1` | addon |
| Supernova Add-on | $200 | `vibespace_supernova_addon_monthly_v1` | addon |

Required metadata must match the owner-approved handoff.

Subscription composition:

- Spark = Access line item only.
- Higher tiers = Access plus exactly one selected add-on on one subscription/invoice.

### Server authority

- Never trust client amount, plan name, credits, metadata, or Price mapping.
- Resolve Price ID to plan server-side.
- Validate expected line-item composition.
- Separate `access_status` from hosted-service `tier`.
- Keep Stripe subscription/customer/invoice IDs in server-authoritative records.
- Use idempotency keys for checkout/portal creation where applicable.
- Prevent duplicate active Access subscriptions.
- Reconcile existing duplicate/legacy subscriptions with an owner-reviewed migration plan.

### Webhook requirements

Audit `supabase/functions/stripe-webhook` and all checkout/portal functions.

The webhook must:

- read the unmodified raw request body;
- validate `Stripe-Signature` using the endpoint secret;
- reject invalid timestamps/signatures;
- store an idempotency record keyed by Stripe event ID;
- tolerate duplicate delivery;
- tolerate out-of-order delivery;
- handle concurrent processing safely;
- return a fast success only after the event is durably accepted;
- process through an atomic, retryable state transition;
- record processing status and redacted error;
- avoid logging full payloads when they contain private data;
- retrieve canonical Stripe objects when event shape is insufficient;
- never downgrade a newer state based on an older event;
- support replay from the idempotency ledger;
- expose an owner/admin reconciliation action;
- fail closed on unknown prices or malformed line items.

Audit event handling for at least:

- Checkout completion;
- customer/subscription creation and update;
- invoice paid;
- invoice payment failed;
- subscription deletion;
- trial ending where applicable;
- refunds/disputes when entitlement policy requires action;
- portal changes;
- asynchronous payment events when supported.

### Stripe tests

Use:

- official Stripe test mode;
- Stripe CLI forwarding;
- signed webhook fixtures;
- duplicate replay;
- shuffled out-of-order sequence;
- concurrent delivery;
- temporary database failure;
- malformed signature;
- wrong endpoint secret;
- unknown Price ID;
- missing Access line item;
- two add-ons;
- canceled checkout;
- failed payment/grace-period transition;
- test clocks for renewal and lifecycle.

Do not activate live mode. Produce an owner checklist for live activation.

---

## 14. Supabase authority and free-tier design

### Correct project identity

Before any mutation, verify the intended VibeSPACE project and expected alias:

```text
jarvis-one-app-supabase
```

Do not touch AccessRevamp, a game project, or another Supabase environment.

### Data model requirements

- One server-authoritative monthly credit budget.
- Atomic reserve, settle, and release.
- Access entitlement separate from optional tier.
- Signed Stripe webhook is entitlement source of truth.
- RLS enabled.
- Customers cannot edit plan, balance, budget, usage, Stripe IDs, or entitlements.
- Existing-user migration is transactional and idempotent.
- Billing-period reset follows Stripe period boundaries.
- UI receives the exact backend balance.
- Preserve approved 30-day trial, three-day grace period, and controlled-launch gate unless the owner changes them.

### Free-tier optimization

At execution time, verify official current quotas. Then:

- inventory every table, row count, index, policy, trigger, function, storage bucket, realtime channel, and scheduled job;
- remove duplicate or unused polling/realtime subscriptions;
- add indexes proven by query plans;
- eliminate N+1 queries;
- paginate large lists;
- bound retention for logs, jobs, usage events, webhook payload metadata, and diagnostics;
- archive or aggregate old usage records;
- avoid storing large binary model/training data in the database;
- use storage only where appropriate;
- keep Edge Function invocations bounded;
- deduplicate retries;
- cache stable catalog data;
- use connection pooling correctly;
- enforce statement timeouts where appropriate;
- ensure migrations are forward-only, numbered, testable, and reversible through a documented corrective migration;
- create a manual export/backup procedure because free-tier recovery features may be limited;
- document measured thresholds that require upgrading.

### RLS/security tests

Create tests proving:

- user A cannot read user B’s private records;
- user cannot edit own entitlement;
- user cannot set tier;
- user cannot increase balance;
- user cannot alter usage costs;
- anonymous access is denied where expected;
- service role paths are limited to server functions;
- multi-account plugins remain account-scoped;
- custom models, projects, chats, and training jobs remain owner-scoped;
- deleted account cleanup does not orphan exploitable records.

### Load and concurrency tests

Use a local/staging Supabase environment, not production.

Test:

- parallel credit reservations;
- overspend prevention;
- webhook plus usage concurrency;
- 1x, 10x, and expected launch traffic;
- burst login/session refresh;
- chat history pagination;
- project restoration;
- plugin-account lookup;
- nightly context update;
- quota-exhausted behavior.

Produce a capacity report, not a guarantee.

---

## 15. Provider billing migration

Approved direction:

| Capability | Primary |
|---|---|
| Hosted chat | DeepSeek with an explicit supported model ID |
| Phone transport | Telnyx |
| SMS | Telnyx |
| Streaming STT | Deepgram Flux |
| Cloud TTS | Deepgram Aura |
| Economy TTS experiment | Telnyx Inworld Mini after testing |
| Offline TTS | Kokoro |

### Migration requirements

- Inventory every Twilio-specific function, environment variable, database column, UI label, test, and document.
- Replace only through a coordinated migration.
- Do not leave both providers ambiguously active.
- Verify Telnyx webhook signatures.
- Use idempotency for calls/messages.
- Support STOP/HELP and applicable messaging compliance.
- Complete required 10DLC registration before production A2P messaging.
- Record actual segments/carrier costs.
- Use a long-lived media gateway for real-time calls; do not treat a short Edge Function as the audio loop.
- Deepgram streaming credentials remain server-side.
- Preserve partial/final transcript, interruption, timeout, cancel, and privacy behavior.
- Settle actual audio duration and provider-specific rates.
- Use explicit current DeepSeek model IDs.
- Reserve conservatively; settle actual input/output/cache usage.
- BYOK/local requests bypass company billing.
- Never silently switch a customer to company-paid inference.

---

# PART IV — PROVIDER CONNECTIONS, PLUGINS, MCP, AND MODEL ROUTING

## 16. AI provider and CLI bridges

Audit the canonical provider registry, model registry, secure credentials, CLI detection, authentication, routing, health probes, and model selector.

### Codex / OpenAI

The current “Sign in” behavior must not merely open a GitHub README authentication section and then report success.

Required state separation:

- CLI not installed;
- installed;
- unsupported version;
- not authenticated;
- authenticated;
- health verified;
- model inventory refreshed;
- selected route active;
- request working;
- rate/quota unavailable;
- error with actionable reason.

Use only official supported Codex authentication. A ChatGPT subscription must not be treated as a general OpenAI API key. Do not scrape browser cookies or private credentials.

The model selector must show only models genuinely available through the selected route.

### Other providers

Apply the same truth contract to:

- Anthropic/Claude Code;
- Gemini;
- xAI;
- DeepSeek;
- Qwen;
- Copilot;
- OpenCode;
- Ollama;
- supported local runtimes.

Requirements:

- exact route selected;
- no silent fallback;
- independent key/CLI/OAuth/local modes;
- bounded health check;
- cached but refreshable models;
- cancelable streaming;
- first-token timeout;
- idle timeout;
- clear error mapping;
- route state persisted per chat where required;
- disconnected providers do not appear usable.

Fix `Jarvis failed` for a selected local Llama model by repairing the actual kernel/runtime authority path, not by hiding the error.

---

## 17. Plugins, OAuth, MCP, and multiple accounts

### OAuth-first, truthful setup

For providers with supported OAuth/app authorization:

- use authorization code + PKCE;
- validate state;
- use nonce where appropriate;
- validate callback/deep link;
- use bounded timeout;
- handle cancellation;
- handle duplicate callbacks;
- store tokens securely;
- rotate/refresh tokens safely;
- request minimum scopes;
- show the exact account and scopes;
- support disconnect/revoke;
- never collect provider passwords.

For GitHub repository access, prefer a GitHub App when its fine-grained installation/account model fits better than a broad OAuth token. GitHub sign-in and GitHub repository integration may use different authorization objects; do not conflate them.

Supabase connections must distinguish:

- signing into VibeSPACE using Supabase Auth;
- connecting a user-owned Supabase project/plugin;
- the VibeSPACE operator backend.

### Plugin account model

Support multiple accounts per plugin without duplicating the plugin package.

Each connection needs:

- stable connection ID;
- provider;
- user-defined display name;
- verified account identity;
- scopes/capabilities;
- read/write/execute classification;
- connection status;
- last health check;
- expiration/refresh state;
- selected default;
- disconnect/reconnect;
- account-specific tool namespace.

Chat mentions must allow unambiguous routing, for example a provider plus account label. Do not expose private tokens in mentions.

### MCP gateway

Audit the VibeSPACE MCP gateway:

- transport;
- endpoint validation;
- authorization;
- tool discovery;
- schema validation;
- permissions;
- invocation;
- streaming;
- cancellation;
- result-size limits;
- attachment handling;
- error redaction;
- account isolation;
- trust prompts.

Required UI:

- trusted/untrusted;
- read-only;
- write;
- external side effects;
- command list;
- connection status;
- endpoint;
- authorization method;
- last error;
- reconnect;
- uninstall/remove;
- per-account selection.

A tool must not gain write capability because another account or plugin has it. Embedded plugin calls in chat must be explicit in the request trace and respect approvals.

### Required real tests

Where credentials/environments are available:

1. complete a GitHub authorization;
2. verify the VibeSPACE app identity and callback;
3. list permitted repository data;
4. perform one approved read test;
5. perform one owner-approved write test in a safe fixture repository;
6. disconnect and verify revocation/local removal;
7. connect a second account and prove isolation;
8. perform equivalent safe Supabase connection tests when supported.

If credentials are unavailable, prepare the exact owner setup and do not claim the integration is fully verified.

---

# PART V — CHAT, ATTACHMENTS, BROWSER AGENT, AND WORKBENCH

## 18. Chat correctness and experience

Preserve the current VibeSPACE shell. Improve only the named behavior.

Required:

- ChatGPT-like conversational streaming behavior inside VibeSPACE styling.
- Stable markdown/code rendering.
- Cancellation.
- Retry.
- message persistence;
- project persistence;
- selected model persistence;
- agent/model switch;
- custom model section;
- attachment chips;
- context-map attachments;
- plugin mentions;
- agent emoji/icon;
- clear active provider/route;
- no duplicate composer focus rings;
- prompt upgrade works in manual and automatic modes;
- automatic upgrade sends the upgraded prompt only to the AI as specified;
- no local-model dependency when a different route is selected.

### Slash-command helper

Do not pretend a provider supports native slash commands when it does not.

Implement a safe helper panel that may:

- list supported VibeSPACE commands;
- collect options;
- generate a text artifact/prompt;
- attach it to chat;
- invoke a real registered local VibeSPACE action where authorized.

Every command must map to a real handler. No decorative slash-command list.

---

## 19. Drag-and-drop and attachment ingestion

### Global chat drop experience

When valid files are dragged over chat:

- show one clear theme-aware overlay;
- say `Drop files here` or equivalent;
- do not whiten/freeze the full app;
- accept multiple files within limits;
- provide rejection reasons;
- attach to the current chat;
- preserve files through send/retry where allowed;
- cancel cleanly;
- remain keyboard/accessibility friendly.

### Supported source families

Build Your Own AI and chat must categorize:

- videos;
- images;
- documents/text;
- code/HTML;
- other supported formats.

### MP4/video

If video support is promised:

- inspect actual container/codec;
- extract metadata;
- extract audio where present;
- transcribe through an approved local/cloud route;
- optionally sample frames through a bounded pipeline;
- show size, duration, status, and estimate;
- do not call the raw video “trained” merely because it was uploaded;
- isolate FFmpeg/media tooling;
- verify licensing and signatures for bundled binaries;
- reject unsupported/corrupt codecs clearly.

### HTML

If HTML support is promised:

- parse as untrusted content;
- do not execute scripts;
- remove active content;
- extract readable text/metadata/links;
- preserve source reference;
- protect against huge DOM/entity expansion;
- show sanitized preview where safe.

### Images and documents

- use bounded decoders;
- protect against decompression bombs;
- show exact size/type/pages/dimensions;
- support OCR only through a verified route;
- never fabricate extracted text;
- provide per-file status;
- support cancel/retry;
- cache outputs with content hashes.

### Limits

Define and enforce:

- per-file size;
- total batch size;
- file count;
- video duration;
- page count;
- extraction timeout;
- disk reservation;
- temporary-file cleanup;
- malware scan policy where applicable.

---

## 20. Workbench browser

The current iframe behavior is not a full browser. Keep safe embeds for embeddable content, but do not label them as universal browsing.

### Required architecture decision

Implement and document one secure desktop path:

- native Tauri remote Webview/WebviewWindow with strict capability isolation; or
- system-browser handoff where full embedding is unsafe or unsupported.

Remote pages must not inherit privileged local app APIs.

### Required browser capabilities where supported

- navigation;
- back/forward;
- reload/stop;
- address validation;
- downloads with confirmation;
- popup/new-window policy;
- external protocol policy;
- permission prompts;
- cookie/session isolation;
- separate data directory/profile when supported;
- clear browsing data;
- certificate/error handling;
- OAuth redirect handling;
- zoom;
- crash recovery.

### Security boundaries

- block `file:`, `javascript:`, `data:`, `tauri:`, and unsupported schemes;
- restrict local network access where not required;
- deny Tauri bridge injection;
- do not proxy around CSP/X-Frame protections;
- do not share VibeSPACE credentials;
- keep remote page origin visually clear;
- isolate downloads;
- expose an “Open externally” fallback.

### Acceptance

- YouTube watch URLs may use the official embed player in preview.
- YouTube home/channel pages must open in a proper browser surface or externally.
- GitHub/Google/X/Reddit pages that block iframes must no longer show a misleading generic failure.
- Browser-agent functionality must use the real browser control route and expose what it can/cannot control.
- Remove cloud browser options if the product decision is local-only.
- Reconnect approved local/Pro MCP browser tools and verify automatically only where authorization actually exists.

---

# PART VI — BUILD YOUR OWN AI / MODEL FOUNDRY

## 21. Product truth

The feature must clearly separate:

### Knowledge / RAG

- model weights do not change;
- files are parsed, chunked, embedded/indexed, and retrieved at runtime;
- fastest and most hardware-friendly;
- useful for private knowledge and frequently changing data.

### LoRA / QLoRA fine-tuning

- a limited set of model weights/adapters changes;
- creates a custom behavior/style/task adapter;
- requires compatible training runtime, model, hardware, storage, and dataset;
- often the recommended actual fine-tuning method **only when the hardware/runtime supports it**.

### Full fine-tuning

- changes the full model weights;
- greatest control and greatest compute/storage/risk;
- may be impractical on a normal consumer PC;
- must be disabled with an honest reason when unsupported.

Do not label RAG as weight training. Do not automatically recommend LoRA on hardware that cannot safely run it.

---

## 22. Official hardware detection

Replace browser guesses with a native installed-app inventory.

Collect through safe OS/native APIs:

- CPU manufacturer/model;
- physical/logical cores;
- architecture;
- relevant instruction-set features;
- total and available RAM;
- GPU adapters;
- GPU vendor/model;
- dedicated VRAM where available;
- shared GPU memory where available;
- driver/runtime information where available;
- free storage on selected training volume;
- OS/version;
- virtualization/runtime requirements;
- installed local model runtimes;
- installed training worker version;
- battery/AC state where relevant;
- thermal/power caution where measurable.

### Rules

- unknown remains unknown;
- do not infer dedicated VRAM from system RAM;
- do not claim “best for you” until compatibility rules run;
- preserve raw diagnostic evidence for the user;
- allow refresh;
- handle multi-GPU;
- handle integrated-only GPUs;
- handle driver query failure;
- never crash when WMI/DirectX/vendor tooling fails;
- keep scans bounded and cancelable.

### Compatibility engine

For every method/model, evaluate:

- RAM;
- VRAM;
- disk;
- architecture;
- runtime;
- model format;
- quantization;
- context length;
- dataset size;
- expected duration range;
- thermal/power warning;
- confidence level.

Show:

- recommended;
- compatible but slower;
- risky/not recommended;
- unsupported;
- reason;
- required upgrade/action.

Users may select a non-recommended but technically supported model after a clear warning. Truly unsupported choices remain disabled.

---

## 23. Local training worker

The message “verified local training worker has not been installed” must lead to a real, reliable lifecycle.

### Required worker lifecycle

- manifest-driven install;
- signed/hash-verified artifacts;
- exact version;
- platform/architecture selection;
- disk check;
- resumable download;
- atomic install;
- verification;
- health probe;
- repair;
- update;
- uninstall;
- logs;
- redacted diagnostics.

### Runtime isolation

Training must run in a separate worker process, not the UI process.

Required:

- bounded job queue;
- one or safely limited concurrent jobs based on hardware;
- persisted job state;
- cancel;
- pause where technically supported;
- retry;
- crash detection;
- orphan cleanup;
- checkpoint/resume where supported;
- stdout/stderr capture with limits;
- no uncontrolled shell string;
- sandboxed working directory;
- resource limits;
- app restart restoration;
- sleep/restart handling;
- background notification;
- no invisible perpetual “setting up.”

The app may minimize/close to tray while a job continues only when the worker is deliberately designed for it. The user must see that state and be able to stop it.

---

## 24. Build Your Own AI wizard

### Step 1 — purpose

Use quick, professional, user-friendly questions:

- What should this AI help with?
- What should it know?
- How should it respond?
- Who will use it?
- Is privacy/local-only required?

Keep advanced controls behind progressive disclosure.

### Step 2 — method

Show RAG, LoRA/QLoRA, and Full Fine-Tuning with plain-language descriptions, effects on weights, hardware need, expected time, privacy, and recommendation.

### Step 3 — base model

Show at least five **verified-current** catalog options across speed/quality tiers where licenses permit.

Do not hardcode stale model aliases without checking the approved manifest.

Every row must include:

- exact model/version;
- provider/source;
- license/use restrictions;
- parameter/quantization info;
- download size;
- expected RAM/VRAM;
- quality/speed category;
- hardware fit;
- selectable state;
- why recommended;
- source/hash.

“Best for your PC” must be generated from the actual hardware scan.

### Step 4 — identity

Require a non-empty model name before review/training.

Support:

- model name;
- emoji/icon from approved assets;
- short description;
- default behavior;
- optional advanced system instructions;
- safety/permission profile.

### Step 5 — sources

Support categorized sections:

- Videos;
- Images;
- Documents;
- Code/HTML;
- Other supported.

Show per source:

- name;
- type;
- exact size;
- duration/pages/dimensions;
- extraction state;
- estimated processing time;
- errors;
- remove/retry.

### Step 6 — review

Review must show:

- required model name;
- chosen method;
- base model;
- hardware fit;
- worker status;
- total source size;
- source counts by category;
- estimated disk requirement;
- estimated duration range with confidence;
- privacy route;
- expected output artifact;
- known limitations;
- cancel/return.

Never display `unnamed model`.

### Step 7 — train/build

- start real job;
- persist job;
- show real stages;
- allow leaving the page;
- continue in background where supported;
- notify on completion/failure;
- verify output artifact;
- run a small validation prompt;
- never mark complete before load validation.

### Step 8 — use

After success:

- add to custom model library;
- select in chat;
- attach to an agent;
- show icon/name/description;
- show local storage;
- show compatibility;
- provide manage/refine/retrain/add-sources/export/delete controls where technically supported;
- version the model/artifact;
- preserve old working version until replacement verifies.

---

## 25. Custom model management

Create one canonical custom-model registry.

Each item contains:

- stable ID;
- owner;
- name;
- icon;
- description;
- method;
- base model/version;
- artifact path;
- manifest/hash;
- runtime;
- size;
- created/updated;
- source summary;
- status;
- compatibility;
- active version;
- linked agents;
- last load result.

### Actions

- use in chat;
- connect/disconnect agent;
- view details;
- add knowledge sources;
- rebuild index;
- refine/retrain where supported;
- duplicate;
- export where license allows;
- archive;
- delete with confirmation.

Do not imply that RAG sources can always be converted into a fine-tuned model without a new training job.

---

# PART VII — PERSISTENCE, ACCOUNT, AVATARS, PROJECTS, AND DELETION

## 26. Persistence contract

Verify persistence across app restart, update, crash recovery, sign-out/sign-in, and offline use for:

- chat history;
- projects;
- project settings;
- selected model/agent;
- custom models;
- training jobs;
- local model catalog;
- plugin accounts;
- provider route;
- settings;
- task usage module;
- context maps;
- All About Me/JarvisLearning;
- Command Center plans/boards/schedules where supported.

Use schema versions and migrations. Test corrupted/partial records. Provide backup/export where appropriate.

### Destructive actions

Default:

- project delete requires confirmation;
- custom model delete requires confirmation;
- context map delete requires confirmation;
- account/data deletion requires strong confirmation;
- terminal close/clear uses existing hold behavior where specified.

Add a settings option to reduce hold/confirmation friction only for lower-risk local actions. Do not allow a global switch to silently bypass high-risk account, billing, cloud, or irreversible deletion confirmations.

Prefer soft-delete/trash/undo for recoverable local objects.

---

## 27. Profile avatars

The owner wants preloaded characters rather than arbitrary profile-photo upload.

Required:

- create a catalog of 50 original, license-safe VibeSPACE character avatars;
- do not copy protected characters, celebrities, actors, or franchise likenesses;
- consistent art direction;
- optimized assets;
- accessible labels;
- keyboard selection;
- preview;
- persistence;
- graceful fallback;
- no remote tracking URL.

Production may use source sheets during creation, but runtime must ship individual optimized assets and a manifest. Do not depend on cropping a sprite sheet at runtime if that harms quality/accessibility.

---

# PART VIII — PET OVERLAY, TERMINALS, COMMAND CENTER, TOOLS, AND CONTEXT

## 28. Pet and pet-panel overlay

Preserve the existing pet-panel visual design.

Implement the pet as a dedicated, transparent, always-on-top Tauri window with documented behavior:

- survives main-window minimize;
- survives main-window close-to-tray;
- tray process remains active;
- pet remains visible when pet panel closes;
- clicking pet opens existing panel;
- panel follows or anchors correctly;
- monitor/DPI changes work;
- multiple monitors work;
- startup restore works;
- crash/restart recovery works;
- low-resource idle animation;
- pauses/reduces work on battery/fullscreen where appropriate;
- respects a user toggle;
- never injects into another app;
- never captures game input unexpectedly;
- does not claim it can overlay protected exclusive-fullscreen games when the OS prevents it.

Chat, terminal, models, and animations inside the panel must use the same canonical runtime as the main app, not duplicated fake state.

---

## 29. Terminals

Audit terminal creation, PTY lifecycle, provider launching, working directory, command palette, logos, connected files, pane close, and native invoke availability.

### Open in Terminal dialog

Show a real logo for each supported provider.

Do not incorrectly rename `Custom executable path` to `Custom prompt`.

Instead separate:

- **Executable** — program to run;
- **Startup command or arguments** — what it receives;
- **Project directory** — working directory;
- **Initial prompt** — optional text sent after the provider is ready, if supported.

Use `Ex.` for examples as requested.

Fix `Cannot read properties of undefined (reading 'invoke')` through capability/host checks and native integration, not a try/catch that hides failure.

Validate:

- executable exists;
- project directory exists;
- arguments are safely passed;
- environment is scoped;
- process starts;
- output streams;
- resize works;
- close kills or detaches according to policy;
- no zombie processes;
- browser mode gives an explicit desktop-only state.

Keep hold-to-close/clear default where already required.

---

## 30. Command Center

Preserve the existing UI unless a small settings button/status correction is required.

Make every visible card/action real.

Audit and correct:

- `preloaded`;
- `download available/unavailable`;
- runtime/model selection;
- project planning;
- project board;
- schedule automation;
- run dev server;
- ship check;
- open terminal;
- local verification command;
- removed cloud actions;
- stale Gemini-key wording;
- scrolling;
- zero-saved/tools counters;
- status diagnostics.

### Command Center model/runtime

Add a small settings surface for selecting the canonical local/cloud model route where needed. Do not bundle a secret or silently use a paid model.

### Useful tools

Replace decorative tools with real, safe tools.

Example: **Storage Review**

- scans owner-approved roots;
- categorizes large, duplicate, cache, old, build, temporary, and unused candidates;
- shows last access/modified when reliable;
- reports size;
- never automatically deletes;
- excludes operating-system and protected application data by default;
- requires review/confirmation;
- supports open location;
- supports safe trash;
- clearly states when “unused” is only an estimate.

Other tools must be grounded in actual user workflows and registered handlers, such as:

- repository health;
- dev-server launch;
- dependency status;
- release readiness;
- YouTube/API connector setup;
- MCP connection test;
- local model storage;
- stale build artifacts;
- project backup/export.

Do not create a master prompt that instructs an AI to freely search and delete the whole computer.

---

## 31. Voice, selected assistant, phone, and notifications

### Identity

The selected assistant profile is canonical.

If Jarvis is selected, do not show `Ask Friday`. Remove hardcoded identity strings across files, voice, wake phrases, notifications, tools, and empty states.

### Voice/STT/TTS

- distinguish local and cloud;
- real download/install lifecycle;
- no `runtime not integrated` dead end when the feature is advertised;
- permission handling;
- microphone device handling;
- click-to-talk state machine;
- hands-free state machine;
- no stream ownership conflict;
- interruption;
- partial/final transcript;
- cancellation;
- timeout;
- selected voice truth;
- provider health;
- local fallback;
- no mislabeled fallback.

### Phone/SMS

- preserve owner-approved Telnyx/Deepgram direction;
- contacts;
- approved outbound action;
- exact callee;
- callbacks;
- usage settlement;
- failure recovery;
- inbound policy;
- number validation;
- compliance;
- no client-side company secrets.

### Notifications

Verify:

- permission;
- Windows native notifications;
- click action;
- training completion;
- call/message state;
- scheduled task reminders;
- background/tray state;
- no duplicate notifications;
- quiet/reduced mode.

---

## 32. Context, Nightly Second Brain, and JarvisLearning

### Scrolling and scheduler

Fix any page where content cannot scroll.

Nightly Second Brain must:

- use one canonical schedule;
- survive restart;
- use idempotent run IDs;
- avoid duplicate runs;
- report missed/failed runs;
- catch up safely;
- respect timezone;
- avoid overlapping jobs;
- record last success;
- never silently claim completion.

### Every-20-message learning update

Update All About Me/JarvisLearning after each completed 20-message threshold using:

- canonical message count;
- one idempotent update per threshold;
- privacy controls;
- bounded summarization;
- source references;
- no fabricated facts;
- conflict handling;
- manual refresh;
- clear last update.

### Context Map

Create a dedicated full-page map route while keeping a compact preview on the context page.

Required:

- black graph canvas in every theme;
- typed nodes/edges;
- pan/zoom;
- search/filter;
- keyboard access;
- stable persisted layout;
- grouping;
- details inspector;
- actual retrieval pulses;
- pulses only when the runtime accesses related context;
- bounded 3D/electric effects;
- deletion particle effect;
- reduced-motion alternative;
- no graph freeze;
- separate project maps;
- persistence;
- restore;
- delete confirmation.

Use Obsidian graph behavior only as visual interaction inspiration. Do not copy proprietary assets or claim parity without proof.

---

# PART IX — TARGETED UI, ANIMATIONS, USAGE, AND TOKEN SETTINGS

## 33. Explicitly authorized UI changes

Outside this list, preserve current UI.

Authorized:

- Build Your Own AI wording and hierarchy;
- theme-correct contrast for `Best for your PC`;
- four lower modules may use clearer theme-aware glass treatment;
- agent emoji/icon on agent page and chat;
- 50-avatar selector;
- source categories and training summary;
- custom-model section in selectors/settings;
- one unified composer highlight rather than two circles;
- scroll fixes;
- plugin/account permission/status controls;
- terminal provider logos and clarified fields;
- Command Center settings button and real statuses;
- dedicated Context Map page and requested graph effects;
- task usage module visibility;
- intro animation timing;
- targeted Warm-theme clarity;
- required error/recovery states.

Do not introduce a broad design-system rewrite.

### Accessibility

Every visual correction must retain:

- contrast;
- visible focus;
- keyboard operation;
- semantic labels;
- screen-reader status;
- reduced motion;
- forced-colors behavior;
- scalable text;
- no information conveyed only by color.

---

## 34. Intro animation and fullscreen

Modify the existing intro animation timeline:

- beginning/message-readable section: 35% slower;
- ending/show-mouth section: reduce that section’s duration by 35%;
- preserve intended transitions;
- verify text readability;
- avoid frame skipping.

Verify intro behavior:

- approved startup/restart frequency;
- native fullscreen;
- entire display filled;
- no Windows taskbar visible while native fullscreen succeeds;
- no blurry stretch;
- correct aspect handling;
- escape/recovery;
- multi-monitor;
- reduced-motion or skip behavior;
- no permanent fullscreen lock;
- no startup crash when video decode fails.

Test timeline durations, not only visual screenshots.

---

## 35. Task usage bar and token optimization

### Task usage module

When enabled, it must appear.

Verify:

- one instance only;
- monitor/edge placement;
- off-screen recovery;
- restart restoration;
- provider ordering;
- top providers;
- live events;
- polling backoff;
- no enabled-but-invisible state;
- theme support;
- no unnecessary CPU;
- truthful unavailable quota state.

### Token optimization

Default token optimization is **off**.

For each mode/tier:

- define exact max-output behavior;
- never exceed model/API context constraints;
- preserve room for input/tools;
- show effective limit;
- let `Final Boss` use a higher verified ceiling;
- do not claim a number unsupported by the selected model;
- persist setting;
- no hidden truncation;
- surface provider refusal clearly.

---

# PART X — TESTING AND PROOF

## 36. Testing strategy

The owner does not want a shallow `npm typecheck` pass or one enormous, expensive Playwright suite.

Use a layered strategy.

### Layer A — repository baseline

At coherent boundaries:

```text
npm run typecheck
npm --prefix app run test
npm run test:release-manifest
npm run build
cargo check --manifest-path app/src-tauri/Cargo.toml
```

Mirror CI and use release-mode Rust checking where CI does.

### Layer B — focused frontend tests

Add regression tests beside every corrected feature:

- error boundary;
- authority host;
- invoke availability;
- provider route;
- model selector;
- plugin account isolation;
- drag/drop;
- Build Your Own AI;
- scrolling;
- task module;
- assistant identity;
- destructive confirmation;
- persistence;
- animation timeline.

### Layer C — Rust/native tests

Test:

- IPC validation;
- hardware scan;
- process lifecycle;
- PTY;
- worker installer;
- path validation;
- hashes;
- tray/windows;
- pet overlay;
- webview isolation;
- updater/signing input;
- native notification;
- cancellation.

### Layer D — Supabase tests

Use local Supabase/SQL tests for:

- migrations;
- RLS;
- entitlement authority;
- credit reserve/settle/release;
- concurrency;
- billing-period reset;
- idempotency;
- data isolation;
- retention.

### Layer E — Stripe tests

Use Stripe test mode/CLI/test clocks and signed replay tests.

### Layer F — provider contract tests

Mock protocol boundaries deterministically, then run a minimal live test only when credentials and owner authorization exist.

### Layer G — native smoke automation

Use a focused installed-app smoke harness for:

- launch;
- main route;
- Tauri invoke;
- terminal;
- hardware;
- local worker;
- pet/tray;
- browser window;
- drag/drop;
- persistence restart;
- fullscreen intro.

### Layer H — limited browser/UI automation

Use Playwright only for a small, high-value browser-compatible smoke set and visual/accessibility checks. Do not crawl the entire app or substitute browser tests for native verification.

### Layer I — performance and fault injection

Test:

- provider timeout;
- offline;
- slow disk;
- corrupt file;
- corrupt model;
- worker crash;
- database retry;
- duplicate webhook;
- quota exhaustion;
- sidecar missing;
- window destroyed;
- GPU query failure;
- no microphone;
- canceled OAuth;
- app restart during training;
- low disk;
- memory pressure.

---

## 37. Device and environment matrix

At minimum verify:

- Windows 11 standard user;
- Windows 11 admin only where installer requires elevation;
- low-memory device;
- integrated GPU device;
- discrete NVIDIA/AMD device where available;
- high-DPI display;
- multi-monitor;
- offline;
- slow network;
- fresh install;
- upgraded install;
- browser/Vite mode for supported fallback behavior;
- installed Tauri app for native behavior.

Do not claim macOS/Linux support merely because web mode renders. Report platform coverage actually tested.

---

## 38. Release acceptance matrix

Every row needs evidence.

| Area | Required proof |
|---|---|
| White/not responding crash | reproduction no longer freezes; fault stays within feature boundary |
| `invoke` undefined | native path works; browser path gives explicit fallback |
| Kernel authority error | local message succeeds or actionable bounded error; no stale authority |
| Training worker | install/verify/health/job/cancel/restart proof |
| Hardware | CPU/RAM/GPU/disk values from native evidence; unknown handled |
| Build Your Own AI | named model required; five verified choices; source categories; ETA; usable artifact |
| MP4/HTML | real processing or explicit supported-limit error |
| Custom model | appears in manager and chat; linked agent route verified |
| Stripe | signed webhook, duplicate/out-of-order tests, correct entitlement |
| Credits | exact tier totals and concurrent overspend prevention |
| Supabase | correct project identity, RLS proof, capacity report |
| Codex bridge | official auth state and working request, or honest missing owner action |
| Other providers | route-specific health/model/request proof |
| Plugins | OAuth/callback/scopes/read-write/multi-account proof |
| MCP | tool discovery, permission, invocation, isolation |
| Workbench browser | secure native/external path; no CSP bypass |
| Pet | persists in tray/minimize and recovers |
| Terminals | logos, fields, PTY lifecycle, no zombie |
| Command Center | visible actions map to real handlers |
| Context | full page, persistence, actual retrieval pulse |
| Voice/phone | selected identity, STT/TTS, approved call path |
| Task usage | enabled means visible |
| Token optimization | default off; effective limits truthful |
| Intro | timing and fullscreen proof |
| Packaging | signed artifacts, hashes, updater, AV scan |
| Persistence | chats/projects/settings/models/jobs survive restart |
| Deletion | required confirmations and setting policy |
| Mocks | no production mock/default/fake states |
| Source credits | license inventory and attribution complete |

---

# PART XI — OWNER INPUTS AND EXTERNAL SETUP

## 39. Required configuration checklist

Do not ask for or commit secret values in this document. Report only names, purpose, and where the owner must set them.

### Desktop-public build configuration

Likely required after audit:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_APP_VERSION
VITE_ACCESS_LEASE_PUBLIC_KEYS
VITE_PHONE_JARVIS_CLOUD_URL
```

Only keep public/client-safe values in the desktop build.

### Supabase/server secrets

Audit and normalize exact names. Expected categories include:

```text
SUPABASE_SERVICE_ROLE_KEY
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
APP_BASE_URL
APP_VERSION
DEEPSEEK_API_KEY
DEEPGRAM_API_KEY
TELNYX_API_KEY
TELNYX_PUBLIC_KEY
TELNYX_CONNECTION_ID
TELNYX_MESSAGING_PROFILE_ID
TELNYX_PHONE_NUMBER
```

Add only variables actually required by the final implementation.

### Stripe public identifiers/server mapping

Record test and live separately:

```text
STRIPE_ACCESS_PRICE_ID
STRIPE_ORBIT_ADDON_PRICE_ID
STRIPE_NOVA_ADDON_PRICE_ID
STRIPE_SINGULARITY_ADDON_PRICE_ID
STRIPE_SUPERNOVA_ADDON_PRICE_ID
```

Exact aliases may differ, but there must be one canonical mapping and no ambiguous legacy names.

### OAuth/app setup

For each supported provider, report:

- app type;
- client ID;
- client secret location;
- callback/deep-link URL;
- scopes;
- installation URL if applicable;
- test account;
- production approval requirement.

Expected priority:

- GitHub App/OAuth;
- Supabase-related user project connection if supported;
- Google;
- Slack;
- Notion;
- Figma;
- other catalog integrations.

### Release credentials

Report requirements for:

- Windows code-signing certificate;
- updater signing key;
- public updater verification key;
- release hosting;
- publisher identity.

Never request private keys through chat or commit them.

---

## 40. Owner-action report

At the end, generate a short, exact owner checklist divided into:

### Can be completed by the agent now

Code, tests, migrations, local test environments, test Stripe objects where authenticated, docs, release scripts, diagnostics.

### Requires owner login/approval

Examples:

- Stripe test/live account activation;
- Stripe endpoint creation;
- Supabase project selection/secrets;
- OAuth app registration;
- GitHub App installation;
- Telnyx number/10DLC;
- code-signing certificate;
- Microsoft Store submission;
- live-provider credentials.

### Remains release-blocking

Only list evidence-backed blockers.

---

# PART XII — COMMIT, EVIDENCE, AND FINAL HANDOFF

## 41. Commit discipline

Use small coherent commits such as:

```text
fix(runtime): contain native authority and invoke failures
fix(billing): harden stripe webhook idempotency
fix(data): enforce atomic shared-credit ledger
fix(creator): isolate local training worker lifecycle
fix(plugins): add account-scoped oauth state
fix(workbench): route blocked sites to isolated native webview
fix(pet): persist overlay through tray lifecycle
perf(app): remove hidden polling and render churn
test(release): add native fault and recovery matrix
docs(release): record owner setup and proof
```

Do not combine unrelated changes into one giant commit.

Do not force-push or rewrite PR history.

---

## 42. Required final evidence report

Create a final PR #31 report containing:

1. starting PR head;
2. ending PR head;
3. exact changed paths by slice;
4. root cause per reported error;
5. fix summary;
6. tests run;
7. test results;
8. native environments exercised;
9. Stripe test evidence;
10. Supabase project identity and local/staging evidence;
11. performance before/after;
12. security findings;
13. signing/installer evidence;
14. owner inputs still needed;
15. unresolved blockers;
16. known limitations;
17. rollback instructions;
18. no-unverified-claims statement.

Use these status labels only:

- `VERIFIED`;
- `IMPLEMENTED — EXTERNAL VERIFICATION REQUIRED`;
- `BLOCKED — OWNER ACTION REQUIRED`;
- `BLOCKED — TECHNICAL`;
- `NOT STARTED`.

Do not use “fully working,” “production ready,” “zero crashes,” or “complete” unless every corresponding gate is genuinely proven.

---

## 43. Definition of done

This master goal is complete only when:

- every P0 is fixed or explicitly blocks release;
- no known whole-app white-screen/not-responding reproduction remains;
- Stripe test mode passes signed, replay, duplicate, out-of-order, lifecycle, and entitlement tests;
- shared credits match the owner-approved contract;
- Supabase authority/RLS/concurrency tests pass;
- free-tier capacity is measured and documented;
- provider routes and model inventory are truthful;
- plugins/MCP are permissioned and account-isolated;
- Workbench does not pretend iframes are a universal browser;
- Build Your Own AI uses real hardware evidence and a reliable isolated worker;
- MP4/HTML support is real or honestly limited;
- custom models can be managed and selected;
- chats/projects/settings/jobs persist;
- destructive actions follow policy;
- the pet overlay survives tray/minimize as designed;
- Command Center and tools invoke real handlers;
- selected assistant identity is consistent;
- context scheduling and map persistence work;
- task usage module is visible when enabled;
- intro timing/fullscreen behavior is verified;
- release artifacts are signed/scanned or explicitly blocked by missing owner credentials;
- baseline CI passes;
- focused native/security/load tests pass;
- source licenses/credits are complete;
- PR #31 contains an honest evidence report;
- no live deployment, merge, or billing activation occurred without separate approval.

---

## 44. Immediate first actions for the implementation agent

1. Confirm repo, PR #31, and `agent/pr30-fixes-and-updates`.
2. Read the owner-approved billing/provider handoff.
3. Read `AGENTS.md`.
4. Read the existing production-functionality goal and current audit log.
5. Record current head and dirty state.
6. Create the compact execution ledger.
7. Reproduce the white/not-responding crash, training-worker crash, `invoke` error, and kernel-authority error.
8. Run secret scan and baseline checks.
9. Fix P0 runtime containment before feature polish.
10. Audit Stripe/Supabase authority before changing any catalog or migration.
11. Continue phase by phase without subagents.
12. Commit only verified slices to PR #31.
