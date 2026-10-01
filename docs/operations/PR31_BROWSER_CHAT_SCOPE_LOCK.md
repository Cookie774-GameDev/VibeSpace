# PR31 Browser Chat Scope Lock

## Authorized scope

This PR-31 change is limited to Browser Chat, its provider child-WebView host, its VibeSpace-owned shell and metadata, the global Browser Chat relay host, and the narrow existing MCP/capability interfaces Browser Chat requires.

## Protected systems

The following systems must preserve their existing behavior and are not authorized for Browser Chat-specific semantic changes:

- normal/native VibeSpace Chat;
- native Chat message execution and provider/model routing;
- RLM and project-context semantics;
- agents and sub-agents;
- voice/Jarvis voice behavior;
- drone-related systems;
- terminals, files, Git, Playwright, and downstream MCP authority implementations except for narrow delegation interfaces already owned by those systems;
- billing, Stripe, Supabase production behavior, authentication policy, installers, releases, and deployment;
- unrelated application UI and infrastructure.

## Required boundary

Browser Chat provider content remains provider-owned. Provider WebViews receive no broad VibeSpace/Tauri authority. Local capabilities are exposed only through authenticated, account/project-scoped, permission-driven VibeSpace relay and broker boundaries.

Browser Chat route visibility must not own or terminate the global MCP relay. Leaving Browser Chat hides the provider child immediately but does not shut down trusted global transport.

Normal VibeSpace Chat must not import or execute Browser Chat provider-runtime code.

## Release safety

Keep PR #31 draft. Do not merge, deploy, publish a release, activate live billing, mutate production Supabase/Stripe, export provider cookies, or weaken existing security/tests as part of this Browser Chat repair.
