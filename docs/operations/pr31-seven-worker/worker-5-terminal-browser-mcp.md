# Worker 5 — Terminal, Browser, MCP, Plugins, Tools, Quick Launch

## Scope

- Task: `VS-PR31-W5-TERMINAL-BROWSER-MCP-20260808`
- Role: Worker 5 Terminal/Browser/MCP writer
- Requirements: PR31 master sections 12 and 17
- Starting and ending HEAD: `b81d93489b39b307204fbb7b6747799d50c32384`
- Worktree: `pr31-w5-terminal-browser-20260808`
- External mutation: none

The existing PTY isolation/lifecycle, isolated Browser Chat child WebView, truthful provider shell,
read-only device relay, account-scoped VibeSpace MCP gateway, Workbench, plugin, and tool
implementations were preserved. No provider DOM, cookies, credentials, phone-cloud files, shared
native registration, production deployment, or Git state was touched.

## Remaining gaps closed

1. Browser Chat accepted a same-origin plaintext `ws://` relay URL returned by an HTTPS ticket
   gateway. The ticket exchange now accepts only HTTPS gateways or loopback HTTP development
   gateways, requires the corresponding WebSocket protocol (`https:` → `wss:`, local `http:` →
   `ws:`), the same host, the exact relay path, no userinfo or fragment, and a query containing
   exactly one bounded opaque `ticket` pair.
2. Quick Launch reported success for an unknown `jarvis://` action even when no VibeSpace feature
   handled it, causing the launcher to close on a dead action. Custom actions now use a cancelable
   event acknowledgement; an unhandled action produces an unavailable warning and returns failure,
   so the launcher remains open.

Both changes were implemented with observed RED/GREEN regression cycles.

## Verification evidence

### Focused application tests

- RED: `npm run test -- --run src/lib/bridge/useBrowserChatRelay.test.tsx`
  - failed because a same-origin `ws://` downgrade resolved successfully.
- GREEN: the same relay suite passed 9/9 after gateway, protocol, and ticket validation.
- RED: `npm run test -- --run src/features/launcher/launch.test.ts`
  - failed because the unknown action returned `{ ok: true }`.
- GREEN: the launcher suite passed 2/2 after truthful event acknowledgement, including a positive
  custom listener that calls `preventDefault()` and is removed after the test.
- Fresh combined changed-path gate:
  `npm run test -- --run src/lib/bridge/useBrowserChatRelay.test.tsx src/features/launcher/launch.test.ts`
  - PASS: 2 files, 11 tests.
- Focused domain gate covering Browser Chat, bridge, MCP gateway/authorization/transport, terminal
  queue/output/restart/project/restore, Workbench persistence/browser security, plugins, tools, and
  launcher:
  - PASS: 27 files, 253 tests.
- Initial broad owned-directory gate reached one failure only:
  `terminalWarmIdleScene.test.tsx` expects four untracked Warm artwork assets absent from this sparse
  worktree. Those shared assets are outside Worker 5 ownership; no product behavior failure was
  inferred and no out-of-scope asset was created.

### Static and native checks

- `npm run typecheck`
  - `BLOCKED_ENVIRONMENT`: sparse-worktree exclusions omit shared visual fixtures, Supabase shared
    functions, Tauri capability JSON, and Jarvis fixtures. No diagnostic referenced a changed Worker
    5 file.
- `cargo test --manifest-path app/src-tauri/Cargo.toml --lib --no-default-features terminal::tests`
  and the Browser Chat native test selector:
  - `BLOCKED_ENVIRONMENT`: Tauri build script requires absent `resources/intro/*` in this sparse
    worktree. No Rust source changed.
- VibeSpace MCP Worker `npm test` / `npm run typecheck`:
  - `BLOCKED_ENVIRONMENT`: the pre-existing worker dependencies are not installed
    (`@cloudflare/vitest-pool-workers` missing). Dependencies were not installed or changed.
- `git diff --check`
  - PASS.
- Focused Prettier check on the changed relay files and new launcher test:
  - PASS. `launch.ts` retains its pre-existing compact preset formatting to avoid unrelated churn.

### Live, read-only evidence

- OpenCode 1.18.14 inventory:
  - requested “DeepSeek 3 by OpenCode Zen” label is not currently present;
  - closest listed DeepSeek free route is `opencode/deepseek-v4-flash-free`;
  - other listed free routes were recorded without paid fallback.
- A harmless CLI response probe on `opencode/deepseek-v4-flash-free` timed out after 180 seconds
  with no output. The exact task-started OpenCode PID was verified by executable and command line,
  then stopped. This is `BLOCKED_ENVIRONMENT`, not a model pass.
- Native UI slot:
  - `BLOCKED_ENVIRONMENT`: Windows Computer Use listed and rehydrated the VibeSpace Edge window, but
    every state capture failed with `node_repl exec context not found`.
  - No blind input was attempted; no terminal, provider page, Edge window, or VibeSpace process was
    changed. Post-integration native acceptance remains assigned to `/root`.
- Public VibeSpace MCP endpoint:
  - `/health` returned `ok=true`, `name=VibeSpace MCP`, `transport=streamable-http`, and
    `relay=durable-object-websocket`;
  - protected-resource metadata advertised the exact MCP resource and Supabase OAuth issuer;
  - an anonymous initialize request returned HTTP 401 with the branded Bearer metadata challenge.

## Security and isolation

- Relay tickets cannot be downgraded from encrypted WSS when issued by the HTTPS gateway.
- Returned ticket URLs remain pinned to the trusted host and path and reject userinfo, fragments,
  missing tickets, and duplicate tickets.
- Browser/provider pages still receive no privileged Tauri injection, local authority, DOM
  scraping, cookie access, password storage, or fabricated connection/usage state.
- VibeSpace MCP remains owner-OAuth protected, account-scoped, project-grant scoped, and read-only
  on the device relay. Mutations remain unavailable/approval-described rather than silently enabled.

## Risks, rollback, and next action

- Native PTY, Browser, Workbench, provider-session, reconnect/logout/expiry, and OpenCode response
  behavior require post-integration execution through a working native control path.
- Worker-package tests require the already-declared dependencies to be installed by the integrator's
  normal verified environment.
- Rollback is limited to the four changed application files and this evidence document; no external
  rollback is required.
- Next action: `/root` reviews and integrates this bounded diff, runs full TypeScript/Worker/Rust
  gates from the complete integration worktree, and performs the recorded post-integration native
  smoke without provider data or paid model use.

## 2026-08-09 cross-review follow-up: relay auth cancellation

The Browser Chat relay hook now subscribes to Supabase auth changes before reading the initial
session and owns a generation-scoped abort controller for each authenticated start. A sign-out,
missing session, replacement token, disabled transition, or effect cleanup invalidates the prior
generation, aborts its ticket request, resets the corresponding Browser Chat bridge singleton, and
ignores any subsequent completion or status callback from that generation.

Each `BridgeClient` connect and reconnect resolves a fresh one-use relay ticket through the same
auth-generation-scoped resolver. The generation's controller remains alive after the initial
connection so sign-out, disable, token replacement, or cleanup also aborts a reconnect ticket.
`resetBrowserChatBridgeClient()` synchronously runs the old client's stop path, while the resolver's
post-await abort checks prevent an abort-ignoring fetch from returning a late usable URL. Ticket
requests have a 10-second aborting timeout while retaining the prior gateway protocol, same-origin,
exact path, and single opaque ticket validation.

Regression evidence:

- RED: the original hook did not expose an abort signal while a ticket was pending because the auth
  subscription was installed after `start()`; the cleanup test also observed an old `connected`
  callback replacing `disabled`.
- A parent review then verified that pre-acquiring one fixed ticket would break reconnects because
  the relay enforces one-use, 60-second tickets. RED coverage observed no per-connect resolver and
  no second ticket. GREEN coverage now proves distinct initial/reconnect ticket URLs, aborts a
  delayed reconnect ticket on sign-out, and rejects its late completion/status.
- GREEN: `useBrowserChatRelay.test.tsx` passes 14/14, covering the 10-second timeout, fresh one-use
  reconnect tickets, initial and reconnect sign-out aborts, and ignored post-cleanup status.
- Timeout mutation check: changing the production bound from 10 seconds to 20 seconds made the
  focused timeout test fail (`expected false to be true`); restoring 10 seconds returned it green.
- Fresh changed gate: relay plus Quick Launch passes 2 files / 16 tests.
- Fresh Worker 5 focused gate: 27 files / 284 tests pass. The output-router fault-isolation test
  intentionally emits its established diagnostic while passing.
- Full app TypeScript remains `BLOCKED_ENVIRONMENT` only by the previously documented sparse
  worktree omissions. After correcting the new test fixture's nullable-session type, no diagnostic
  references either changed relay file.

## 2026-08-09 signed-in provider-session checkpoint

The owner confirmed that the browser-owned ChatGPT account session is signed in and the VibeSpace
MCP app is connected. This checkpoint is treated as external provider state: VibeSpace does not
recreate it, inspect provider cookies or DOM, or claim that the desktop can independently verify
the ChatGPT app connection.

Four app-side contract gaps were corrected:

1. The desktop relay previously started only after an ephemeral local project-read grant. A normal
   app restart therefore left the already-connected ChatGPT MCP app without a desktop relay until
   local file access was approved again. The relay now starts from the restored signed-in
   VibeSpace account session, with zero local tools until an explicit session-only project grant is
   added. The account Durable Object accepts this authenticated no-grant registration and reports
   a connected desktop with no workspace or tools. Local reads remain unavailable until the exact
   account/project grant is present.
2. Browser Chat repeated the VibeSpace access token in its WebSocket registration after already
   exchanging that token for a signed, short-lived, one-use relay ticket. Browser Chat
   registration no longer carries the token; every initial connection and reconnect still obtains
   a fresh ticket with the current VibeSpace token.
3. The Browser Chat header always asked the user to “Sign in or sign up.” It now says “Open
   ChatGPT,” preserving the provider-owned session and leaving any actual expiry prompt to
   ChatGPT. The UI distinguishes the verified desktop-relay status from the provider-owned
   ChatGPT app/session status.
4. A relay failure was hidden behind the provider’s default `not_configured` status. Browser Chat
   now exposes the relay error truthfully instead of suggesting that setup is merely incomplete.

Ticket validation now also rejects a ticket at its exact expiry instant rather than accepting it
for that boundary second. No provider page, cookie, DOM, credential, message, or live ChatGPT
action was read or changed.

Focused evidence:

- RED: `BrowserChatHub.test.tsx` observed `useBrowserChatRelay(false)` for a signed-in VibeSpace
  account with no local grant; GREEN starts the authenticated relay independently of file access.
- RED: `BridgeClient.test.ts` observed the raw VibeSpace token in the Browser Chat registration;
  GREEN proves neither the token nor absolute local root is transmitted.
- RED: the Browser Chat header exposed “Sign in or sign up”; GREEN exposes only “Open ChatGPT.”
- GREEN: Browser Chat plus bridge gate passes 11 files and 72 tests, including per-chat
  Native/Browser separation, persisted safe preferences, provider isolation, fresh reconnect
  tickets, logout/token-change cancellation, read-grant scoping, and MCP preflight.
- The Worker Vitest/typecheck harness is environment-blocked by the absent predeclared
  `@cloudflare/vitest-pool-workers` package. No package or lockfile was changed.
- A direct already-cached TypeScript smoke proved exact-expiry ticket rejection. An earlier
  mistaken `npx tsx` invocation fetched `tsx@4.23.11` into the user npm cache before failing on
  eval module format; it did not change repository manifests, lockfiles, or source. This
  out-of-scope cache mutation was disclosed immediately to the controller.
