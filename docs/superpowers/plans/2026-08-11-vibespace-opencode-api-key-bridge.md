# VibeSpace OpenCode API Key Bridge

**Phase:** PR31 Phase 7
**Starting HEAD:** `829b4fd1`

## Outcome

VibeSpace's OS credential vault remains the only source of truth for API-key
connections. The native OpenCode server launcher reads allowlisted credentials
at process start, writes only `{env:VIBESPACE_OC_*}` references into its
app-owned config, and injects raw values only into the owned child process.

## Native boundary

- Reuse the existing guarded keyring store and account naming.
- Read only the explicit Phase 7 provider allowlist.
- Reject empty or oversized vault values before process construction.
- Convert each provider to a fixed VibeSpace-owned environment variable name.
- Generate JSON through `serde_json`, never string interpolation.
- Store the same secret-free config in the atomic file and
  `OPENCODE_CONFIG_CONTENT`.
- Keep child stdout/stderr null and all launch/config errors static.
- Custom `Debug` output may include provider IDs and environment names but must
  replace every value with `[REDACTED]`.

The launch attempt fails closed if the vault cannot be read. Tests inject an
in-memory credential source and fake process launcher; they never touch the
real keychain or start OpenCode.

## Credential changes

The existing frontend secure-save flow keeps this order:

1. write the vault;
2. read it back and compare without logging;
3. stop only VibeSpace's owned OpenCode child if one is running;
4. ask the runtime manager to detect/start a fresh generation;
5. refresh provider discovery through the new generation.

Deletion removes the vault value before the same controlled refresh. If no
server is running, no server is started solely because a key changed; the next
normal start reads the new vault state.

The process restart rotates Basic-auth credentials. Existing Phase 4 runtime
events update the frontend connection before new sends. VibeSpace itself is not
restarted.

## Provider truth

The scoped config contains a provider entry only when VibeSpace has a verified
vault value for it. OpenCode's own existing auth store remains untouched and
may independently expose authenticated providers through
`/config/providers`. The Phase 6 bridge therefore reports availability from
the restarted server instead of assuming that a saved key worked.

## Verification

- Native add/update/delete source fixtures.
- Secret-free config file and config-content environment.
- Exact distinct child environment mapping.
- Redacted debug/error/output behavior.
- Controlled stop/refresh ordering and no-start-when-stopped behavior.
- Provider presence/absence after regenerated config.
- Existing credential, server lifecycle, frozen builder, and frontend harness
  regression suites.
