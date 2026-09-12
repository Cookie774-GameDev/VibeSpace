# Worker 1 — Identity, Auth, Cloud, and Website Hub

## Authority

- Task: `VS-PR31-W1-IDENTITY-CLOUD-20260808`
- Role: Worker 1 Identity/Auth/Cloud writer
- Starting and ending HEAD: `b81d93489b39b307204fbb7b6747799d50c32384`
- Requirements: master sections 8, 18, 19, and 23–27
- Cloud/external mutations: none

## Implemented

- Added password recovery by six-digit email code, password confirmation, and authenticated
  password change. Existing password sign-up, sign-in, sign-up verification, and passwordless
  email-code sign-in remain intact.
- Added branded, code-only confirmation, sign-in, recovery, and email-change templates to local
  Supabase configuration. Templates include expiry and phishing-safe copy without remote images
  or tracking.
- Added an account-scoped desktop-presence schema with explicit Data API grants, owner-only RLS,
  authenticated security-definer RPCs, revocation that fails closed, and server-side structural
  bounds for every metadata item and provider metric.
- Added a desktop heartbeat that publishes identifiers, bounded display metadata, current runtime,
  and aggregate counts only. It does not publish commands, terminal output, chat messages,
  prompts, filesystem paths, keys, or secrets. Heartbeats do not overlap, mark offline on clean
  disposal, and age offline after two minutes on the website.
- Replaced the static account guide with a real website Account Hub using the same Supabase
  identity. It supports password and six-digit email-code sign-in, validates the current user
  through Auth, reads owner-scoped profile/subscription/Access/usage/presence authority, renders
  through `textContent`, and permits presence revocation only. URL session detection is disabled.
- Prepared a bounded OAuth 2.1 PKCE helper contract: high-entropy state and verifier, S256
  challenge, five-minute expiry, exact redirect and state checks, in-process single-use replay
  rejection, verifier-bound body exchange, any-2xx token response handling, and no credentials in
  URLs. Production search found no caller, so this helper is not a shipped continuity flow.
- Hardened Account Hub transitions against cross-account races. Every Auth transition invalidates
  a monotonic generation, clears account-derived DOM, and keeps the hub hidden until reads for the
  captured user finish and both the generation and current user are revalidated.
- Made plan display fail closed. A paid plan label now requires an error-free authoritative
  subscription in an accepted active, trialing, or grace state; stale profile tier data,
  subscription errors, missing rows, and inactive states display `Not confirmed`.
- Unified every sign-in dialog close path behind a local reset-before-parent-close handler so
  recovery phase, email code, password, and confirmation cannot survive cancel/reopen.
- Reset the full sign-in state on controlled `open=false` transitions as well, covering parents
  that close the dialog without a Radix callback.
- Bound account password UI to the exact trimmed cloud account ID. Account changes remount and
  reset the panel, invalidate in-flight operation generations, and suppress stale completion
  status and toasts.
- Bound desktop presence heartbeat work to its captured cloud account. Identity changes invalidate
  delayed collection/publishing and skip stale offline RPC cleanup; the website TTL remains the
  truthful fallback for an old account's last heartbeat.
- Follow-up review closed two post-invocation races. Every sign-in dialog request now captures a
  monotonic dialog generation; controlled close/reopen invalidates the generation, so delayed
  recovery send, code verification, password update, sign-in, sign-up, email-code, and resend
  continuations cannot alter the new UI, emit a toast, or close it.
- Presence publish and offline cleanup now send the captured cloud user ID as an explicit RPC
  precondition. The security-definer functions compare it with `auth.uid()` and raise before any
  insert or update when authentication changed while the shared client request was in flight.
- Account usage, checkout, and portal continuations now bind to an exact account generation.
  Identity changes synchronously clear usage and suppress stale results, billing URLs, and toasts.
- Installed Access now keys its authorization host and runtime to the exact cloud user ID, enters
  loading on same-tier account switches, and ignores bootstrap sessions superseded by Auth events.
- Account Hub consumes password and OTP input values before awaiting Auth and clears both fields
  plus OTP visibility on every transition. Device revocation now carries the rendered account ID
  into SQL, where `auth.uid()` mismatch is rejected before mutation.
- Added a generic recovery-link callback path without enabling broad URL session detection.
  Callback material is accepted only for an explicit recovery type, removed from the address
  synchronously before asynchronous Auth work, and exchanged through the shared Supabase
  singleton. The resulting new-password dialog is bound to the exact recovered user, email, and
  UI generation; account drift, malformed or replayed callbacks, and wrong callback types fail
  closed with a generic message. Cancel and successful password update locally revoke the
  recovered session. The existing six-digit recovery flow remains independent and unchanged.

## Focused verification

- `npm test -- --run src/features/account/AccountPage.identity.test.tsx src/features/account/AccountSecurityPanel.test.tsx src/features/access/InstalledAccessAppHost.auth.test.tsx src/features/access/AccessAppHost.test.tsx src/features/access/DesktopPresencePublisher.test.ts src/features/auth/SignInDialog.recovery.test.tsx src/features/auth/accountContinuity.test.ts src/lib/supabase/desktopPresence.test.ts src/features/auth/AuthGate.smoke.test.tsx src/features/billing/planLimits.test.ts`
  — 10 files, 65 tests passed.
- `node --test tests/account-hub.test.mjs tests/access-pricing.test.mjs tests/oauth-consent.test.mjs tests/appearance.test.mjs tests/origami.test.mjs` from `site`
  — 15 tests passed, including delayed Account A to Account B transition behavior,
  stale/missing/error subscription authority, transition secret clearing, and account-bound
  device revocation.
- `node --test tests/config_auth_templates.test.mjs tests/desktop_presence_migration.test.mjs`
  from `supabase` — 8 tests passed.
- Follow-up strict RED reproduced all three dialog generation leaks and both missing SQL
  expected-account contracts. Focused GREEN verification passes 20/20 frontend tests and 4/4
  desktop-presence migration contracts.
- Final strict RED reproduced stale Account A usage and billing continuations, same-tier Access
  authorization reuse and stale session bootstrap, retained website password/OTP input, and
  unbound device revocation. Fresh focused GREEN verification is recorded above.
- Generic recovery callback RED first failed because no bounded callback consumer existed, then
  the callback-dialog RED proved the dedicated recovered-session password UI was absent. Fresh
  GREEN verification passes 20/20 callback, App integration, and recovery-dialog tests; the app
  TypeScript build also passes.
- Callback cross-review follow-up now rejects duplicate recognized parameters, cross-query/hash
  conflicts, mixed or empty transports, and any callback without exactly one recovery type. Once
  session establishment has been attempted, every returned error, malformed session, or thrown
  continuation performs a best-effort local sign-out, including adapters whose cleanup throws
  synchronously. The expanded focused gate passes 30/30.
- Prettier check on every touched supported source file — passed.
- `git diff --check` — passed.
- Owned-path scope scan — passed.
- Added-line and untracked-file credential-shape scan — passed.
- `npm run typecheck` — Worker 1 diagnostics are clear, but the command exits 1 on nine
  pre-existing/out-of-scope diagnostics: missing visual fixture modules, missing Tauri capability
  JSON files, missing Jarvis gold-standard JSON, and two implicit-any bindings in
  `src/lib/runtimeProfile.test.ts`.

## Unverified external boundaries

- No migration, deployment, hosted Auth setting, hosted SMTP/template change, mailbox action,
  user creation/deletion, Stripe action, checkout, portal, webhook, or production mutation was
  performed.
- The Supabase CLI, `psql`, and Deno are unavailable in this worktree. The presence migration has
  focused static RLS/shape tests but has not been executed against a local database. Existing
  Deno Stripe handler tests could not be run.
- Hosted branded email requires authoritative hosted Auth/SMTP configuration. Supabase's 2026
  Free-tier SMTP policy may require custom SMTP before hosted custom templates can be enabled.
- `CONTINUITY_STATUS: BLOCKED_EXTERNAL`. Runtime app-to-web continuity is not wired, and master
  section 8.5 is not complete. Production search found the three PKCE helper exports only in
  `accountContinuity.ts`, with no production caller. Completion requires all of:
  1. a registered and verified public OAuth client;
  2. an exact approved redirect allowlist;
  3. durable OS-protected pending verifier and state storage rather than browser storage;
  4. excluded app-shell/Tauri deep-link receipt and token installation into the shared Supabase
     session; and
  5. end-to-end replay, restart, wrong-account, and logout proof.
     The helper must not be represented as automatic or shipped continuity until those external
     authorities and seams exist and the complete flow is tested.
- The Account Hub and presence migration are source-complete but undeployed, so no claim is made
  that the current public site or hosted project exposes them.

## Exact next action

The integrator should first restore or account for the missing current-head TypeScript fixtures,
then run the migration and RLS behavior tests only against a local or proven isolated Supabase
stack. After that, register a verified OAuth public client and delegate the excluded app-shell and
Tauri deep-link wiring so the PKCE flow can be proven end to end. Hosted email/SMTP and Stripe
checks must remain read-only until separate authority is established.

HANDOFF_READY
