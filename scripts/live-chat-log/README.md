# Standalone live HTML chat log

This page runs outside VibeSpace. It reads the running official **native development app** through its existing loopback debug port (9223 by default). It does not start a model, send messages, modify records, or drive the app UI. Node 24 is supported; no additional packages are required for the service.

From the repository root:

```powershell
node scripts/live-chat-log/server.mjs C:/path/to/VibeSpace-Live-Chat-Log.html
```

Open the generated HTML launcher. Keep the service and native development app running. The actual HTML page is served on loopback port 42841 at an unguessable local URL. Set `VIBESPACE_LOG_PORT` or `VIBESPACE_DEBUG_PORT` to override ports. Stop the service with Ctrl+C. Re-running it regenerates the launcher with a fresh URL.

The page follows the active/latest chat, or lets you select one of the latest 200 chats in the active workspace. It refreshes every two seconds after each completed read. Simple and Detailed views, recorded models/tokens/tools/results/file diffs/reasoning/timings, and HTML snapshot downloads reuse the existing redacted diagnostic exporter. Nothing is uploaded or stored by the service. Don't share the private live URL; review snapshot contents before sharing.

Missing or producer-truncated telemetry is labeled. Hidden thinking is unavailable. Backend process uptime and exact provider receipt time aren't recorded by the existing sources. The source report is a snapshot; the outer live HTML page refreshes it. Disconnection removes stale records and retries automatically.

This connector currently requires the native **development** WebView and its source modules. It does not claim compatibility with a packaged release without a debug endpoint. A standalone `file://` page cannot directly read the native app's isolated IndexedDB; the local bridge is necessary.

Checks: `node --test scripts/live-chat-log/server.test.mjs`.
