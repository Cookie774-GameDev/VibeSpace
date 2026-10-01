# VibeSpace PR #31 — Browser Chat + MCP Repair Master Prompt

## Target

- Repository: `Cookie774-GameDev/VibeSpace`
- Pull request: `#31`
- Branch: `agent/pr30-fixes-and-updates`
- Priority: P0
- Scope: Browser Chat and its isolated VibeSpace MCP relay boundary only

## Execution contract

Implement, test, grade, fix, retest, document, and commit the repair. Do not stop at investigation or a plan. Never fabricate a PASS. Keep PR #31 draft and do not merge, deploy production, publish a release, activate billing, mutate production Stripe/Supabase, restore unrelated deletions, reset unrelated work, or overwrite another agent's work.

Use this loop:

```text
REPRODUCE
→ IDENTIFY ROOT CAUSE
→ PLAN A BOUNDED SLICE
→ IMPLEMENT
→ RUN FOCUSED TESTS
→ REVIEW SECURITY/REGRESSION RISK
→ DOCUMENT EVIDENCE
→ COMMIT
```

External OAuth, provider-plan limitations, unavailable credentials, and physical Windows verification must be labeled precisely. They must never be bypassed or represented as locally verified.

## Protected systems

Read broadly, write narrowly. Do not behaviorally change:

- normal VibeSpace native Chat;
- OpenAI/API-model Chat;
- RLM, recursive context, token systems, or model routing;
- Composer, Prompt Forge, agents, agent spawning, or Hive;
- Jarvis Voice or Jarvis normal Chat;
- drone-related modules;
- terminal/Git/Playwright engines except through existing public authority adapters;
- billing, Stripe, subscription entitlement, or unrelated Supabase code;
- pets, themes, Model Foundry, installers, or release machinery.

A shared shell/router edit is allowed only as a narrow visibility seam and must not alter native Chat semantics.

## Required architecture

Browser Chat has two trust domains:

```text
VibeSpace-owned shell and local authority
                │ authenticated, scoped relay
                ▼
Provider-owned consumer web page
```

The provider owns its page, account, cookies, messages, model selector, authentication, and subscription behavior. VibeSpace owns only the local shell, session metadata, account/project binding, relay state, permission policy, tool activity, files/outputs, and native child lifecycle.

### Child WebView

Use a child WebView attached to the main VibeSpace native window. Never use an independently floating always-on-top provider window as the preferred path. Serialize create/show/hide/geometry operations. A child may be visible only when all are true:

```text
route == chat
AND selected chat engine == browser
AND host rectangle is connected and non-zero
AND document is visible
```

Leaving Browser Chat, switching to native Chat, changing accounts, hiding the host, or closing the app must hide the provider child immediately. Do not wait for deferred route teardown.

### Persistent provider profiles

Use one persistent VibeSpace-owned profile per VibeSpace account and provider. Hash the account/profile key before using it as a directory or native WebView label. Never copy browser passwords, browser cookie databases, or authentication tokens. Use an existing Chrome/Edge profile only when the runtime officially supports safe attachment and the behavior is proven; otherwise keep the stable VibeSpace profile.

### Navigation security

Provider child navigation must be HTTPS and allowlisted to the provider plus recognized identity-provider origins required for sign-in. Deny unexpected origins. Provider JavaScript must never receive Tauri file, shell, credential, billing, secret, or arbitrary native command authority.

### MCP relay

The Browser Chat relay is app infrastructure, not route infrastructure. The global app lifecycle owns one account-scoped singleton relay. BrowserChatHub may observe status but must not create a second transport or destroy the global transport when unmounted. Preserve fresh relay tickets, bounded reconnect, account switch isolation, project-grant revocation, and sign-out cancellation.

### Capability truth

Represent separately:

- local implementation;
- VibeSpace permission;
- current health;
- provider support/authorization.

Never advertise a tool as usable unless all required states are true. Preserve the existing secure read-only boundary unless a write/terminal/Git/Playwright adapter is implemented through the existing authority, fully scoped, approval-gated, cancellation-safe, and tested. Do not replace existing native engines with a second implementation.

## Mandatory focused tests

1. Open Browser Chat; provider child appears in the host.
2. Route to Terminal, Files, Settings/account, Context, Workbench, and native Chat; provider hides immediately.
3. Switch active chat engine from Browser to native; provider hides.
4. Resolve a stale in-flight open after route departure; it is re-hidden.
5. Move/resize/maximize/restore the main window; child remains attached and bounds remain parent-relative.
6. Switch VibeSpace accounts; old child hides and the new account uses a distinct persistent profile.
7. Restart; the same account/provider profile survives.
8. Attempt untrusted HTTP/external navigation; it is denied.
9. Leave BrowserChatHub unmounted while signed in; global relay remains supervised.
10. Confirm native Chat still renders, sends, streams, and retains existing model/context/agent behavior.

## Required documentation

Maintain:

- this master prompt;
- `docs/superpowers/specs/2026-08-14-pr31-browser-chat-mcp-repair-design.md`;
- `docs/superpowers/skills/2026-08-14-pr31-browser-chat-mcp-repair-skill.md`;
- `docs/operations/PR31_BROWSER_CHAT_MCP_REPAIR_LEDGER.md`.

## Completion truth labels

Use only:

- `VERIFIED`;
- `IMPLEMENTED — NATIVE VERIFICATION REQUIRED`;
- `IMPLEMENTED — PROVIDER VERIFICATION REQUIRED`;
- `PROVIDER LIMITED`;
- `BLOCKED — OWNER ACTION`;
- `BLOCKED — ENVIRONMENT`;
- `NOT COMPLETE`.

Do not call Browser Chat complete solely because TypeScript or mocks pass. Native Windows evidence is required for the no-overlay claim, and provider OAuth evidence is required for provider authorization claims.
