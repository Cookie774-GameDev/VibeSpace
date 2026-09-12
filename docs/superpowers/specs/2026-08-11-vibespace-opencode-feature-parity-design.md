# OpenCode Feature Parity Design

## Objective

Verify that plugins, MCP, skills, context, All About Me, Jarvis Learning,
files, and Model Foundry retain their VibeSpace-owned behavior while all model
execution crosses the OpenCode-only `runAgent` boundary.

## Existing parity boundary

The runtime already compiles approved file/context attachments, selected
skills, connected plugin/MCP capability context, All About Me, learning
context, and Model Foundry selections before calling `runAgent`. The Phase 10
router makes that call OpenCode-only, while the Phase 11 Tool Gateway exposes
fixed semantic read/update capabilities without private-store filesystem
access.

The parity audit found one intentional placeholder that is no longer
sufficient: `plugins.run` lists fixed plugin operations but always returns
`plugin_operation_unavailable`.

## Safe plugin execution bridge

The generic semantic gateway must not become a generic plugin-action bypass.
Instead:

- the trusted JARVIS security runtime exposes a narrow read-only method;
- it resolves exactly one canonical registered plugin action by the requested
  plugin ID and operation;
- it validates parameters through that canonical registration;
- it executes only through the account-scoped registered plugin runtime;
- writable operations remain rejected with
  `approval_bound_execution_required` and continue through the existing
  canonical action approval path;
- credentials and provider response shapes never cross the bridge.

The Tool Gateway receives only a revocable process-local read port installed
by the active security runtime. Missing, stale, account-mismatched, ambiguous,
or noncanonical authority fails closed.

## Other feature boundaries

- Skills: selected instructions and agent skill addenda are compiled by
  VibeSpace; `skills.list/load` expose bounded catalog metadata/instructions.
- Context/files: VibeSpace resolves safe project data and attachments; only
  normalized prompt parts reach OpenCode.
- All About Me/Learning: guarded stores remain private; exact semantic gateway
  methods mediate reads and updates with source/confidence metadata.
- MCP/plugins: connection/capability truth remains VibeSpace-owned; exact
  registered plugin operations mediate execution.
- Model Foundry: its selected model and compiled prompt use `runAgent` and
  therefore OpenCode, with no direct model transport fallback.

## Verification

Add focused bridge tests, an OpenCode feature-parity source/transport test, and
run the existing plugin/MCP/skills/context/profile/learning/files/Model
Foundry suites. Verify the fixed semantic catalog, private-store boundaries,
typecheck, production build, formatting, and no direct provider-only feature
route.
