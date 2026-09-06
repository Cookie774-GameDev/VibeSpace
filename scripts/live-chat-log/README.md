# App-wide local activity log

Start once from the repository root: `./scripts/live-chat-log/start.ps1`.
This detached Node service survives the chat/terminal that started it. It does not restart VibeSpace. Open `%LOCALAPPDATA%/VibeSpace/ActivityLog/Open-Activity-Log.html`. The private loopback URL stays stable across restarts; nothing is uploaded.

## Files for agents

- `events.jsonl`: appended JSON event records, with instance ID, sequence, local timestamp, operation ID, phase, payload and measured duration where applicable.
- `status.json`: atomically replaced connection state, active operations, latest record and coverage.
- `events.jsonl.previous`: previous rotation. Current file rotates after 32 MiB; one previous file is retained.
- `viewer-url.txt`: stable private viewer URL.

```powershell
Get-Content "$env:LOCALAPPDATA\VibeSpace\ActivityLog\events.jsonl" -Tail 30 -Wait
Get-Content "$env:LOCALAPPDATA\VibeSpace\ActivityLog\status.json"
```

Reopen the tail after rotation. Deduplicate by `(instanceId,event.sequence)` after an uncertain crash: an append can succeed before its checkpoint. Explicit `gap` records mean the renderer buffer lost events before persistence. Preserve rotations separately if you need a longer audit history.

## Recorded sources

| Boundary | Evidence |
| --- | --- |
| Shared model router | Request messages, selected model/connection/purpose, public streams, questions, response/usage and duration |
| Scoped Codex public protocol | Public tool/file/command/usage events and reasoning summaries; private reasoning text is excluded |
| OpenCode transport | Redacted raw provider events before normalization, including provider-reported tool inputs/results and file changes |
| OpenCode prompt HTTP | Local dispatch-to-acknowledgement duration; not upstream model receipt |
| OpenCode harness | ADE and Context/RLM child model streams bypassing the chat router |
| Semantic tool gateway | Actual arguments, queue receipt, start, result/error for context/RLM, SiYuan-backed retrieval, MCP and other registered tools |
| Terminal CLI host | Received terminal command, execution result/error and duration, including context commands |

All these sources record regardless of the selected chat. Correlate session, request and provider call IDs: an operation ID is not an upstream call ID. Repeated raw events may come from multiple subscribers; use native IDs and phase to distinguish updates from new executions. A response with `ok:false` is a failure. A closed stream without a terminal event is not success.

`observedAt` is local epoch milliseconds. `monotonicMs` and `durationMs` use `performance.now()` at the instrumentation boundary. Millisecond formatting does not guarantee remote clock accuracy. Exact remote receipt, token counts, thinking duration and private tools are available only when the provider exposes them. Bare external CLI internals that emit no supported events are unobservable. Missing evidence does not prove no work occurred.

Strings are capped at 16,000 characters, records at 64,000, and the renderer buffer at 2,000 events; truncation and gaps are labeled. Known credentials are redacted before disk export. Conversation and tool content remains private; review before sharing. Diagnostics preserve permissions, callbacks, retries and execution behavior.

## Native connection / your first test

The bridge currently requires the official development Tauri WebView on CDP 9223. A packaged release without this endpoint is not supported. If the running app lacks the port, wait until its work is safely stopped, then launch it with:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'
npm run tauri:dev
```

Do not start a duplicate over an existing instance. The log service reconnects automatically. Closing the HTML viewer does not stop file recording. Historical chat reports remain in a collapsed section and are only re-exported when open.

For your first real test: send a short model request, run a real context/RLM read from an ADE or terminal, and inspect correlated receipt/start/result records. Check actual provider/model and returned source IDs/content. Close the viewer and verify new sequence numbers still reach `events.jsonl`. `status.json` must say connected. The user requested to perform this live test personally; unit tests are not certification of real provider journeys.

Checks: `node --test scripts/live-chat-log/server.test.mjs scripts/live-chat-log/recorder.test.mjs`, plus focused recorder/router/Codex protocol/OpenCode client/harness/terminal/gateway tests.
