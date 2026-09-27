# VibeSpace Relay runtime G7M4

This is an isolated Node process for the pinned upstream Relaycast engine. It keeps SQLite and WebSocket server dependencies out of the Vite/browser bundle. Node 22 or newer is required.

```powershell
Set-Location work/agent-relay-runtime-G7M4
npm install
npm rebuild better-sqlite3
npm test
node .\sdk-engine-acceptance.mjs .\sdk-engine-acceptance-receipt.json
node .\run.mjs --db .\relay.sqlite --port 8787
```

`relay-runtime.mjs` exports `startRelayRuntime({ dbPath, port, fileDir, fileSecret, auth, config })` and `startLoopbackServer(fetch, port)`. The host address cannot be configured: it binds only `127.0.0.1`, then verifies the OS-reported bound address and closes/refuses startup if it differs. It includes the upstream HTTP engine routes, local file routes, and authenticated WebSocket transport. Observer WebSockets require `stream:read`, node WebSockets require node authentication, and browser `Origin` headers are allowed only for localhost origins. Do not expose this local engine through a reverse proxy.

The Node package closure pins `@agent-relay/sdk` 12.4.1, `@relaycast/engine` 8.12.0, and `@relaycast/mcp` 8.12.0, plus the Node server dependencies. The app package manifest is intentionally unchanged because this runtime uses Node-only SQLite and WebSocket APIs. Root integration can launch this process and connect through its returned local base URL; no Composer or UI integration is included here.

On Windows Node 24, no `better-sqlite3` prebuilt was available, so `npm rebuild better-sqlite3` compiled it through node-gyp and the installed Visual Studio Build Tools. The local native SQLite binary is 1,891,328 bytes. The installed dependency tree measured 202,498,773 bytes across 7,893 files (about 193 MiB); it is not bundled into the desktop app by this change. `package-lock.json` contains 139 package entries.

## SDK ↔ engine acceptance

The acceptance command creates an ephemeral local workspace and two distinct agents through `@agent-relay/sdk`, creates a shared channel, sends one authentic agent-authenticated message and a reply from the second agent, stops the engine, restarts it against the same SQLite file, reconnects both token-scoped SDK clients, and reads the persisted thread. The receipt records public IDs and timings only; it never records the workspace key or agent tokens. `npm test` includes this end-to-end test.

Verified on Windows Node 24.16.0: sender and reply IDs matched the two different registered agent IDs, the reply parent matched the sent message ID, both agent reconnect IDs survived restart, and the stored thread was read successfully. Latest saved receipt is `sdk-engine-acceptance-receipt.json`: bootstrap 1,119 ms; registration 224 ms; group setup 123 ms; send 651 ms; reply 271 ms; engine restart 1,568 ms; authenticated reconnect 166 ms; persisted thread read 21 ms; total reported test time 14,975 ms. The engine emitted `provider not delivery-ready; delivery deferred` notices: the test proves durable group messaging and restart persistence, not a live delivery worker or UI integration.
