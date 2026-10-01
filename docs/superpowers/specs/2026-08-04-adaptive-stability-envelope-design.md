# Adaptive Stability Envelope Design

## Goal

Keep VibeSpace responsive during multi-day, multi-project workloads without
changing visible UI, user data, model quality, terminal behavior, or product
features. A renderer failure must recover without terminating live terminals.

## Evidence

At `2026-08-04T17:12:02-05:00`, WebView2 wrote a 10,810,482-byte Crashpad
report while `jarvis.exe` and five native terminal shells remained alive.
The main window became black with a white line and no WebView2 descendants
remained. The current watchdog retries `reload()`, then suppresses process
restart while PTYs are live. Reload cannot revive a destroyed WebView process,
so the safe path reaches a permanent blank window.

The canonical long-run projection also permits 500 recent runs, 500 events per
run, and 500 artifacts per run to be fetched concurrently. Its theoretical
startup burst is therefore 250,000 events plus 250,000 artifacts.

## Design

### Renderer recovery

Use a three-stage recovery ladder:

1. Retry a normal WebView reload twice.
2. Recreate only the failed main WebView window from the checked-in Tauri
   configuration on the main thread.
3. Restart the process only when recreation also fails and no PTY is active.

Recreating the native WebView preserves the Rust process, terminal PTYs,
terminal CLI, durable IndexedDB/local storage, and existing user data. Window
geometry, maximized/fullscreen state, visibility, and focus are restored from
the failed window. Recovery remains bounded by retry delays and the existing
restart circuit.

### Long-run hydration

Keep the newest 500 runs available, but use bounded concurrency for per-run
event/artifact reads. Active or recoverable runs keep the full recent evidence
window; settled historical runs use a smaller recent projection window.
Canonical durable records are never deleted or rewritten. Full run evidence
remains available through the existing on-demand command-center repositories.

### Resource behavior

Retain the 3 GB emergency JavaScript heap ceiling, bounded terminal scrollback,
six-context WebGL budget, bounded diagnostics, and existing persistence
flushes. Allow Chromium to background-throttle hidden renderer work; the
watchdog already ignores hidden windows. Foreground presentation and behavior
remain unchanged.

### Safety and compatibility

- No UI, route, copy, control, model, provider, or product behavior changes.
- No cache/database deletion, migration, reset, or cleanup.
- No live terminal termination.
- No Git staging, commit, push, branch change, deployment, or external mutation.
- Account-scoped repository queries and existing authorization remain intact.
- Recovery attempts and historical projection reads remain bounded.

## Verification

- Strict RED/GREEN native policy tests for WebView recreation before process
  restart and for PTY-safe recovery.
- Focused TypeScript tests for bounded concurrency and projection budgets.
- Rust formatting/check or the narrowest available compile gate.
- Focused frontend tests, production bundle, and scoped diff checks.
- Live evidence must show localhost healthy and the current process/data left
  untouched. Loading the native correction requires a user-controlled restart
  because the active process owns live PTYs.
