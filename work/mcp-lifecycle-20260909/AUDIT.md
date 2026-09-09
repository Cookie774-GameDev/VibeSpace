# MCP lifecycle changes — 2026-09-09

Scope: Browser Agent / packaged Desktop Link only. Base commit: `1ac90589d71dc61127918cd52e705c513df986fa`; branch: `integration/UnifiedChungus-final`.

Implemented:
- Persist setup completion only after a healthy tunnel reports tools. Saving a key or reaching wizard step 3 alone is insufficient. Keep completed setup and intentional Off visible when disconnected.
- Automatically load the existing six real Desktop Commander configuration fields from the verified native connection path. Preserve manual connections and unsaved edits.
- Route the MCP switch through authenticated native/backend controls. Persist Off, stop the tunnel, and reject subsequent MCP requests while retaining configuration access.
- Check tunnel process recovery every second without fetching tool lists each tick. Coalesce launches and back off repeated failures up to 30 seconds.
- Package a separate supervisor for gateway process recovery. Preserve live owner locks; use a graceful IPC shutdown. VibeSpace closure does not stop this separate process.
- Start configured, enabled connections with VibeSpace. Add optional per-profile Windows sign-in startup with registry readback and a hidden launcher. No registration was changed on this computer during this task.
- Remove three unsupported approval switches and their approval claim; retain actual configuration and existing independent agent policy.

Verification evidence in this folder:
- `frontend-tests-final.log`: 15 passing React/client tests, including automatic panel loading, saved Off, and failed-action behavior.
- `package-tests.log`: 13 passing runtime/gateway/supervisor/startup tests. Synthetic processes and temporary fixture directories; no live VibeSpace instance used.
- `native-isolated.log`: the actual native connector module typechecked against cached Tauri/reqwest dependencies. Harness stubs the unchanged runtime-profile gate; it does not validate the complete application.
- `native-pure-tests.log`: 2 passing tests using exact copies of the native connection validator/offline-status functions.
- `release-tests.log`: 45 release-manifest tests passed.
- `typecheck.log`: an earlier full TypeScript check passed. The final repeat and full Cargo checks were stopped when free RAM dropped below roughly 600 MB. Only this task's compiler descendants were stopped. Full final typecheck, full app suite, production build and full native build are not claimed verified.

Limitations:
- No app launch, restart, browser automation, live tunnel verification or sign-in execution test was performed. Changes require a newly packaged build; the currently running app was not upgraded.
- The one-second watchdog is best-effort process recovery, not a guarantee against every crash. It does not forcibly terminate a still-running process merely because a network request is slow. Force-killing the supervisor or shutting down Windows stops it until a later configured startup.
- The runtime registry readback is covered through a mocked executor for writes. Actual sign-in behavior remains unverified.

Owned source paths are recorded in `owned-files.json`. Other agents' changes and staging were preserved.
