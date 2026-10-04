# Plugin Provider Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This task is assigned to one agent; no subagents are authorized. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit all 112 catalog entries and make supported provider-owned authorization usable without overstating connection readiness.

**Architecture:** Keep the plugin credential path and hosted MCP path separate. GitHub uses its registered public OAuth client and device code exchange through the trusted plugin runtime. Hosted MCP providers use OpenCode's OAuth discovery, code exchange, refresh, and stored grant lifecycle; the catalog must identify that path distinctly from a project API key or static help link.

**Tech Stack:** Tauri 2, React, TypeScript, Vitest, OpenCode remote MCP.

**Spec:** `docs/PLUGIN_AUTHORIZATION_AUDIT_2026-10-04.md` and the user-authorized plugin connection task.

## Global Constraints

- Preserve every existing manual connection path and the local no-auth mock.
- Never put provider secrets or grants in source, logs, tests, or chat.
- A provider login URL alone is not a connected account; require code exchange and a verified connected state.
- Use only provider-owned authorization endpoints and official provider documentation.
- Final live acceptance requires an assigned official Tauri instance; unit evidence remains labeled as such.
- Preserve peer locks, files, index, processes, and app instances.

## Review Focus

- Device code issuance succeeds but token polling fails or is cancelled: retain a truthful non-connected state.
- Provider authorization page opens but callback never reaches OpenCode: never mark the catalog card connected.
- Hosted MCP server reports `needs_client_registration`: show the exact registration requirement, not a generic credential form.
- A stored grant expires or is revoked: reconnect and disconnect must remove stale authorization state.
- A generated catalog help URL resembles a login page: do not call it one-click without an implemented exchange.

---

### Task 1: Catalog and provider-doc matrix

**Files:** Create `docs/PLUGIN_AUTHORIZATION_AUDIT_2026-10-04.md`; inspect `catalog.ts`, `providerRegistry.ts`, `authorizationCapability.ts`, `compatibilityMatrix.ts`, and `hostedMcpProviders.ts`.

- [x] Enumerate exactly 112 entries and record current app path, provider-owned authorization support, official source, and remaining blocker per entry.
- [x] Verify shared Google, Microsoft, and hosted MCP families against their current official specifications; verify exceptions individually where provider docs expose a different rule.
- [x] State separately whether OAuth exists at the provider and whether VibeSpace completes the flow today; label unassessed provider programs as unverified.
- [x] Check matrix count and source links against the generated catalog; preserve the mock as local/no-auth.

### Task 2: GitHub device authorization

**Files:** Modify `app/src/features/plugins/githubDeviceAuthorization.ts` and its focused test only if root cause is reproduced; inspect trusted composition in `app/src/lib/jarvis/jarvisSecurityRuntime.ts`.

- [x] Probe GitHub's device-code start boundary with the shipped public client; HTTP 200 and valid provider code response, with no account consent/token. No app defect reproduced at that boundary.
- [x] Review existing denial, expiry, cancellation, and late-response tests; no failing boundary found to justify a code change.
- [ ] Implement the minimum correction and verify cancellation, denial, expiry, secure store, and account probe.
- [ ] Run focused GitHub tests and native acceptance when an assigned instance is available.

### Task 3: Supabase and hosted MCP sign-in

**Files:** Modify `authorizationCapability.ts`, `hostedMcpProviders.ts`, `Plugins.tsx`, and corresponding focused tests only after checking OpenCode's actual OAuth behavior.

- [x] Verify the official Supabase remote MCP endpoint and dynamic client registration requirements.
- [x] Write a failing test for misleading catalog state and missing Figma client-approval prerequisite.
- [x] Confirm existing OpenCode route requires its post-auth `connected` status before success copy; correct stale catalog messaging.
- [x] Keep the project API-key form distinct and preserve its connection probe.
- [ ] Test add/auth/cancel/reconnect status and native provider-owned page when an assigned instance is available.

### Task 4: Final checks and commit

- [x] Run focused plugin tests (56/56), `npm run typecheck` (exit 0), `npm run test:release-manifest` (45/45), and `npm run build` (exit 0). Full app suite attempted and stopped after three unrelated-area failures; Rust check failed on disk exhaustion during dependencies and owned build artifacts were cleaned.
- [x] Identify existing official Tauri processes as assigned to other owners; do not use those instances. No provider account-consent acceptance was performed or claimed.
- [ ] Commit only owned, verified files; record commit, patch, tests, and remaining provider-side blockers in the coordination ledger, then release only this claim.
