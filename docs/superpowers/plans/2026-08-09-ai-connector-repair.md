# PR31 AI Connector Repair Plan

**Task:** `VS-ROOT-20260809T232256Z-AI-CONNECTOR-REPAIR`

## Acceptance contract

1. Connection identity remains `provider family + model + connection id +
   mode + auth source` from Settings through runtime and usage.
2. An authenticated Codex ChatGPT session is discovered automatically and
   revalidated after staleness, focus, Settings/model-picker open, login, and
   qualifying request failures.
3. `openai-codex` can invoke only the Codex adapter; `openai-api` can invoke
   only the API adapter. No cross-billing fallback exists.
4. Secret writes are awaited and read back before in-memory success; network
   validation cannot delete a persisted key; hydration failure is visible and
   recoverable; no secret reaches localStorage or logs.
5. First-use billing-route disclosure is local-only and connection-versioned.
6. Usage is attributed by exact connection. Local analytics expose 24h/7d/30d
   totals with provenance/freshness. Codex quota is shown only when returned by
   the installed official structured protocol.
7. Focused frontend/native tests, TypeScript, bounded Cargo, UI acceptance,
   and real installed Windows acceptance are recorded honestly.

## Execution order

1. Reproduce terminal-versus-bridge Codex behavior and write RED tests.
2. Consolidate exact-route preference and canonical connection health.
3. Repair allowlisted Windows standalone/npm/bun discovery and auth parsing.
4. Preserve `connectionId` and prove exact adapter dispatch/failure isolation.
5. Replace optimistic key writes with an async transactional save/read-back
   contract, autosave state machine, and recoverable vault hydration.
6. Make model availability react to connection events and stale revalidation.
7. Add local first-use disclosure and exact-connection request ledger.
8. Generate/read the installed Codex app-server schema; implement only the
   supported structured rate-limit flow with bounded refresh.
9. Add honest API-window analytics and unavailable provider-billing state.
10. Run focused and broad verification, inspect the installed app, scan for
    secrets, review the exact diff, document limits, and release locks.

## Security and rollback

- Never read or expose raw provider tokens, cookies, or real API keys.
- Execute only canonical allowlisted binaries; never launch arbitrary shims.
- Use a synthetic QA keychain record and always delete it after testing.
- No external account, billing, cloud, deployment, dependency, or Git
  mutation.
- Roll back only task-owned files; existing provider sessions and real
  credentials remain untouched.
