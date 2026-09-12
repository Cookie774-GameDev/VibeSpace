# VibeSpace Minor Fixes — P0 Usage Module

## Scope

Expand the released native taskbar usage utility without changing its window,
placement, router instrumentation, or unrelated product UI:

1. Replace the two-row selector with a deterministic four-provider compact
   ranking and an expandable full registry.
2. Introduce the complete normalized provider, route, source, capability,
   freshness, reset, and error model required by `MINORFIXESGOAL`.
3. Register at least 35 provider definitions through data rather than UI
   branches, including explicit unsupported-usage declarations.
4. Separate a five-second display clock from provider-specific remote TTLs,
   with in-flight deduplication, bounded concurrency, backoff, offline/hidden
   suspension, cached snapshots, and isolated failures.
5. Preserve persisted enablement, provider order, hidden providers, placement,
   native lifecycle, and immediate local request activity.
6. Expose recoverable sanitized mount diagnostics in the existing General
   Taskbar Usage section, and keep provider-specific refresh, management,
   verified billing links, warning thresholds, source/cache/rate-limit details,
   and provider-versus-local reconciliation truthful.

## Verification

Use behavior-first focused tests for normalization, registry size, selection,
scheduling, persistence, compact/expanded rendering, progress semantics, and
failure isolation. Then run the focused taskbar-usage suite, TypeScript, scoped
formatting/diff/secret checks, and the live Browser flow when integration is
ready. A requirement-level closure review supersedes aggregate test counts:
each explicit interaction above must have focused evidence before the slice is
marked verified.

## Rollback

Revert only the files owned by this task. The existing router instrumentation
and native capability/configuration remain untouched. In General settings, only
the Taskbar Usage section and its focused tests are owned; all other settings
remain outside this slice.
