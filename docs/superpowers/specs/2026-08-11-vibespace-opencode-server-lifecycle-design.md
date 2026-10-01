# VibeSpace OpenCode Server Lifecycle Design

**Date:** 2026-08-11

**Status:** Approved by the owner-supplied PR31 OpenCode-only master goal

**Scope:** Phase 4 only

## Outcome

VibeSpace lazily starts one owned, authenticated `opencode serve` process for
Chat. The process binds only to `127.0.0.1`, never enables mDNS, uses a
cryptographically random per-process password held only in memory, passes an
authenticated compatible `/global/health` check, and is stopped through its
owned process handle on restart or app exit.

Phase 4 does not implement the general OpenCode API/SSE client, provider
credentials, sessions, or production Chat routing. Those remain later phases.

## Confirmed upstream contract

The current official OpenCode server documentation confirms:

- `opencode serve --hostname 127.0.0.1 --port <port>`;
- mDNS defaults to disabled and is enabled only by `--mdns`;
- `OPENCODE_SERVER_PASSWORD` enables HTTP Basic authentication;
- `OPENCODE_SERVER_USERNAME` controls the Basic-auth username;
- `GET /global/health` returns `{ healthy: true, version: string }`;
- `/doc` exposes the OpenAPI schema.

Authority:

- <https://opencode.ai/docs/server/>
- <https://opencode.ai/docs/config/>

## Native boundary

`harness/server.rs` owns the complete server lifecycle. Its Tauri-managed
`OpenCodeServerState` contains a mutex-protected server slot and a bounded
recent-crash budget. The running slot owns:

- the exact opaque runtime ID returned by Phase 2;
- the revalidated native executable fingerprint;
- the child process handle and PID;
- Windows kill-on-close job ownership where available;
- loopback port/base URL;
- in-memory username/password;
- compatible server version;
- a unique generation ID used by the crash watcher.

No caller supplies an executable path, hostname, port, username, password,
command, or environment map.

The native command surface is:

- `opencode_server_ensure(executable_id)` — lazy start or reuse;
- `opencode_server_status()` — return the live owned connection or stopped;
- `opencode_server_stop()` — stop only the currently owned process.

The connection response contains the loopback base URL, Basic-auth username
and password, and compatible version. The password is returned only to the
in-process frontend client boundary. It is never included in events, errors,
logs, files, persistent state, URLs, or diagnostics.

## Runtime trust and process launch

Phase 2’s registry is extended to retain the compatible probed version beside
the canonical executable and fingerprint. Every start resolves the opaque ID
through that registry and recomputes the executable fingerprint immediately
before spawn.

The fixed child invocation is:

```text
<trusted-opencode> serve --hostname 127.0.0.1 --port <native-port>
```

The child receives:

```text
OPENCODE_SERVER_USERNAME=vibespace
OPENCODE_SERVER_PASSWORD=<64-character random secret>
OPENCODE_CONFIG=<app-local-data generated config>
OPENCODE_CONFIG_DIR=<app-local-data generated config directory>
OPENCODE_CONFIG_CONTENT={"server":{"hostname":"127.0.0.1","mdns":false}}
```

VibeSpace writes only its own app-local-data configuration and working
directory. It never changes the user’s global OpenCode configuration.
Standard input, output, and error are null; no server output or environment is
logged. Windows launches hidden and suspended, assigns the child to a
kill-on-close job, and resumes it only after containment succeeds.

## Port and health

Native code binds `127.0.0.1:0` to obtain an OS-selected port and keeps the
reservation until immediately before spawn. OpenCode does not currently accept
an inherited listener, so a small unavoidable release/spawn race remains.
Startup retries with a fresh port and fresh process at most three times.

Each attempt polls only:

```text
http://127.0.0.1:<port>/global/health
```

Requests use the in-memory Basic-auth credentials, short connect/read
timeouts, a bounded response body, and strict JSON. Readiness requires
`healthy: true` and a version equal to the trusted Phase 2 probe version.
Unauthorized, malformed, incompatible, exited, or timed-out processes fail
closed and are terminated before retry.

## Ownership and shutdown

The server state never kills by process name or an arbitrary PID. Stop takes
the exact owned slot, verifies its generation, terminates the Windows job (or
the direct child on other platforms), waits for the owned child, and clears
credentials by dropping the slot.

The ordinary Tauri run-event handler calls server shutdown on final app exit.
The monochrome visual-test builder does not manage server state or register
server commands.

## Crash recovery

A watcher is created for each successful generation. It periodically checks
the exact owned child handle. An unexpected exit:

1. atomically clears only the matching generation;
2. emits a bounded `failed` runtime event so Composer freezes sends;
3. records the crash in a rolling five-minute budget;
4. attempts at most two automatic restarts within that window;
5. emits `starting`, then `ready` after authenticated health;
6. remains failed when the budget is exhausted.

Normal stop removes the slot before termination, so its watcher cannot treat a
deliberate shutdown as a crash. Phase 5 reconnects SSE and session state after
the ready event; Phase 4 never claims an interrupted turn completed.

## Frontend readiness

The runtime manager retains the latest compatible opaque executable ID only in
module memory. Compatible detection transitions to `starting`, invokes
`opencode_server_ensure`, stores the returned connection in module memory, and
publishes `ready` only after native authenticated health succeeds.

`getConnection()` exposes the ephemeral connection to the later typed client.
No secret appears in the public `HarnessRuntimeState`. Browser preview keeps
its existing compatibility-ready behavior and never starts a process.

## Verification

Tests use injected launchers, fake owned children, controlled clocks, and local
mock health responders. They cover fixed arguments/environment, loopback port
allocation, Basic auth presence, secret redaction, compatible health, startup
failure cleanup, reuse, stop, unrelated PID immunity, crash budget/restart,
and app-shutdown registration. No automated verification starts a real
OpenCode server.
