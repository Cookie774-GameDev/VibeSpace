# phone-jarvis - Laptop Bridge

*The piece that makes "AI on the phone reaching into my files" real. Companion to `02-architecture.md` and `06-security.md`.*

---

## 1. What the bridge is

A small daemon that runs on your laptop, dials out to the cloud service over WebSocket, registers a set of tools, and executes those tools when the LLM asks. That is it. It is not a server (no inbound port). It is not an MCP server in the strict sense (though it speaks an MCP-shaped protocol so we can later swap in any MCP server). It is a leashed worker.

Three goals, in order:
1. **Safety first.** No surprise writes. No paths outside the workspace. No shell unless explicitly unlocked.
2. **Latency low.** Tool round-trip should add no more than 100 ms to a turn on a healthy network.
3. **Boring code.** This thing runs on your machine and runs untrusted instructions from a phone call. Boring is a feature.

## 2. Connection lifecycle

```
[laptop boot]
     |
     v
[daemon starts] -- reads ~/.phone-jarvis/config.json
     |
     v
[opens WSS to wss://<cloud>/bridge/<token>]
     |
     v
[sends "register" frame with tool catalog + version + workspace_root]
     |
     v
[cloud acks with "registered" frame]
     |
     v
[idle, heartbeat every 15s]
     |
     +-- on tool_call frame: dispatch -> reply with tool_result
     |
     +-- on disconnect: exp-backoff reconnect (250ms, 500ms, 1s, ... cap 5s)
     |
     +-- on SIGTERM: send "deregister", close cleanly, exit
```

Reconnection rules:
- Token is long-lived but daemon-side. The daemon re-presents it on each connect.
- If the cloud rejects the token (revoked, rotated), daemon stops trying and writes an error to its log. User has to run `phone-jarvis rotate` to install the new token.
- Backoff resets to 250 ms after a successful 60-second connection.
- After 24 hours of failed reconnect, daemon raises a desktop notification "phone-jarvis bridge offline" and slows backoff to 60s.

## 3. Wire protocol

JSON over WebSocket. One JSON object per frame, no batching. Frames are typed by a `kind` field.

### `register` (laptop -> cloud)

```json
{
  "kind": "register",
  "token": "<256-bit hex>",
  "daemon_version": "0.1.0",
  "platform": "win32",
  "workspace_root": "C:\\Users\\viper",
  "tools": [
    {"name": "fs.read", "schema": {"path": "string"}, "acl": "read"},
    {"name": "fs.list", "schema": {"path": "string"}, "acl": "read"},
    ...
  ],
  "writable": false,
  "shell_enabled": false
}
```

### `registered` (cloud -> laptop)

```json
{"kind": "registered", "session_id": "...", "server_time": "..."}
```

### `tool_call` (cloud -> laptop)

```json
{
  "kind": "tool_call",
  "call_id": "tc_abc123",
  "name": "fs.read",
  "args": {"path": "~/notes.md", "start_line": 1, "end_line": 200},
  "deadline_ms": 8000
}
```

### `tool_result` (laptop -> cloud)

```json
{
  "kind": "tool_result",
  "call_id": "tc_abc123",
  "ok": true,
  "result": {
    "content": "...file content...",
    "byte_count": 1834,
    "truncated": false,
    "encoding": "utf-8"
  },
  "elapsed_ms": 38
}
```

On error:

```json
{
  "kind": "tool_result",
  "call_id": "tc_abc123",
  "ok": false,
  "error": {
    "code": "PATH_OUT_OF_ROOT",
    "message": "path resolves outside workspace root"
  },
  "elapsed_ms": 4
}
```

### `heartbeat` (both directions)

```json
{"kind": "heartbeat", "ts": 1748534400123}
```

If neither side sends a frame in 30 seconds, the side that notices first sends a heartbeat. If no response in 10 seconds, treat as disconnect.

### `deregister` (laptop -> cloud)

Sent on graceful shutdown.

```json
{"kind": "deregister", "reason": "shutdown"}
```

## 4. Tool catalog (v1)

All paths are resolved relative to `workspace_root` from `register`. `~` and `$HOME` are normalized to the user home dir, then validated against the root.

### `fs.list`
- **Args**: `path` (string, optional, defaults to root), `max_entries` (int, default 200, cap 2000).
- **Returns**: `{entries: [{name, type: "file"|"dir", size_bytes?, mtime?}, ...], total_count, truncated}`.
- **ACL**: `read`.
- **Validation**: path must resolve inside root.

### `fs.read`
- **Args**: `path` (required), `start_line` (int, default 1), `end_line` (int, default 2000), `encoding` (default utf-8).
- **Returns**: `{content, line_count, truncated, encoding, file_size_bytes}`.
- **Caps**: max 50,000 lines or 2 MB content per call. If exceeded, returns `truncated: true`.
- **ACL**: `read`.
- **Notes**: binary files refused; agent gets `BINARY_FILE` error and can suggest a different tool.

### `fs.search`
- **Args**: `pattern` (regex string, required), `path` (optional), `case_sensitive` (default false), `max_matches` (default 50).
- **Returns**: `{matches: [{path, line_number, line_text}, ...], total_count, truncated}`.
- **Implementation**: shells out to `rg` (ripgrep) for speed. If `rg` is not installed, falls back to a slow JS implementation and warns once.
- **ACL**: `read`.

### `fs.glob`
- **Args**: `pattern` (glob, e.g. "**/*.ts"), `path` (optional).
- **Returns**: `{paths: [...], total_count, truncated}`.
- **ACL**: `read`.

### `fs.summarize`
- **Args**: `path` (required), `max_words` (default 200).
- **Returns**: `{summary: "..."}`.
- **Implementation**: reads the file (up to 100 KB), sends to a small fast model (Haiku / GPT-4o mini) for summarization, returns the summary.
- **ACL**: `read`.
- **Notes**: this tool calls an LLM on the laptop's behalf. The LLM key for summarization is configured separately from the call's main LLM. Default: same key as the call.

### `notes.append`
- **Args**: `text` (required).
- **Returns**: `{appended: true, line_count: int}`.
- **Implementation**: appends to `~/.phone-jarvis/notes.md` (NOT the user's general notes file unless explicitly configured). One line per call, prefixed with timestamp.
- **ACL**: `append`.
- **Notes**: special-cased so the agent can take notes without unlocking general write access.

### `notes.read`
- **Args**: `n_lines` (default 50).
- **Returns**: `{content, line_count}`.
- **ACL**: `read`.

### `system.time`
- **Args**: none.
- **Returns**: `{iso, local, tz, day_of_week}`.
- **ACL**: `read`.

### `system.battery`
- **Args**: none.
- **Returns**: `{percent, charging, time_remaining_min?}` or `{available: false}` on desktop.
- **ACL**: `read`.

## 5. ACL tiers

| Tier | Examples | Default | Unlock |
|---|---|---|---|
| `read` | `fs.read`, `fs.list`, `fs.search`, `fs.glob`, `fs.summarize`, `system.*` | always on | n/a |
| `append` | `notes.append` | always on | n/a |
| `confirm` | `fs.write`, `fs.edit`, `fs.delete` | locked | per-action verbal yes |
| `unlock` | `shell.exec` | locked | per-call verbal unlock + spoken phrase |

The `confirm` tier means: the LLM emits a tool call, the cloud service does NOT immediately forward it. Instead the cloud asks the user verbally "you want me to overwrite `notes.md`? say yes to continue." Only on a clean spoken "yes" (matched by the LLM with a confidence threshold) does the cloud forward.

The `unlock` tier means: shell access is off until the user says a passphrase mid-call ("unlock shell"). After unlock, shell tools become `confirm` for the rest of the call and revert to locked at hangup.

## 6. Sandbox rules (laptop side)

The daemon enforces these regardless of what the cloud sends. Defense in depth.

### Path validation
1. Resolve the input path against `workspace_root` using path-canonicalization (`fs.realpath` + symlink resolution).
2. Reject if the canonical path does not start with the canonical root.
3. Reject if any path segment is `..` after normalization.
4. Reject symlinks whose target is outside the root.
5. Reject paths matching the deny list: `.env*`, `.aws*`, `.ssh`, `.gnupg`, `*.pem`, `*.key`, `id_rsa*`, anything inside `~/.config/opencode/` (the persona files), `node_modules/.cache`, `.git/objects`. Configurable.

### Read caps
- Max 2 MB per file read.
- Max 50,000 lines per file read.
- Max 200 entries per directory listing.
- Max 50 matches per search.

### Rate limits (per call)
- Max 100 tool calls per call session. Anything beyond that returns `RATE_LIMIT_EXCEEDED`.
- Max 1 GB total bytes read per call.
- Max 10 minutes of LLM-driven tool activity in a 60-minute window (cooldown if exceeded).

### Confirm-tier handling
- Daemon never executes a `confirm` tool unless the cloud-side `tool_call` frame has `confirmed: true`.
- The cloud is the source of truth on whether the user said yes. Daemon trusts the cloud.
- Daemon still validates the path/args; cloud confirmation does not bypass sandbox rules.

### Audit
- Every `tool_call` is logged to `~/.phone-jarvis/audit/<date>.jsonl` with: timestamp, call_sid, tool, args, result_summary (size + truncation), elapsed_ms, ok/error.
- Result content is NOT logged in full. Only metadata. (We do not want a phone call's full file reads sitting in plaintext on disk forever.)
- Audit log rotates daily, kept 30 days, then deleted.

## 7. MCP compatibility

The tool catalog shape is intentionally MCP-flavored: `name`, `schema`, `description`. We are not running a full MCP server in v1, but the migration path is clean:

- Phase 5 or vNext: replace the built-in tool dispatcher with an MCP client. The daemon becomes a thin proxy that connects to one or more local MCP servers and exposes their tools to the cloud.
- That makes any MCP filesystem server, browser server, IDE server, etc. usable from a phone call without writing custom tools.

For v1 we do NOT use MCP. The reasons: (a) MCP servers are stdio-based which adds a process layer and complicates lifecycle on Windows; (b) we want a tighter sandbox than most MCP servers ship with; (c) the v1 tool set is small enough that one daemon module is the right scope.

When we adopt MCP later we keep the wire protocol between daemon and cloud the same; only the daemon's internal dispatch changes.

## 8. Config file

`~/.phone-jarvis/config.json`:

```json
{
  "cloud_url": "wss://phone-jarvis.fly.dev/bridge",
  "session_token_file": "~/.phone-jarvis/session.key",
  "workspace_root": "C:\\Users\\viper",
  "deny_paths": [
    ".env*",
    ".aws/**",
    ".ssh/**",
    ".config/opencode/**",
    "*.pem",
    "*.key"
  ],
  "tools": {
    "fs.read": {"enabled": true},
    "fs.list": {"enabled": true},
    "fs.search": {"enabled": true},
    "fs.glob": {"enabled": true},
    "fs.summarize": {"enabled": true, "model": "claude-haiku-3.5"},
    "notes.append": {"enabled": true, "file": "~/.phone-jarvis/notes.md"},
    "notes.read": {"enabled": true},
    "system.time": {"enabled": true},
    "system.battery": {"enabled": true}
  },
  "writable": false,
  "shell_enabled": false,
  "audit": {
    "dir": "~/.phone-jarvis/audit",
    "retain_days": 30
  },
  "rate_limits": {
    "max_calls_per_session": 100,
    "max_bytes_per_session": 1073741824
  }
}
```

`session.key` is a separate 64-character hex string, mode 0600. Generated on `phone-jarvis init`.

## 9. Daemon CLI

The daemon has a small CLI for setup and ops:

```
phone-jarvis init              # interactive: prompts for cloud URL, generates session key,
                               #   prints the cloud-side token to install
phone-jarvis start             # run in foreground
phone-jarvis service install   # install as user-mode service (systemd / launchd / NSSM)
phone-jarvis service uninstall
phone-jarvis status            # show connection state, last call, recent errors
phone-jarvis rotate            # rotate session key (must update cloud-side too)
phone-jarvis tail              # tail the audit log
phone-jarvis test fs.read --path ~/notes.md   # run a tool locally without a call (debug)
```

`phone-jarvis status` prints something like:

```
phone-jarvis 0.1.0
connection: connected (uptime 4h 12m)
cloud: wss://phone-jarvis.fly.dev/bridge
workspace: C:\Users\viper
last call: 2026-05-29 14:02 (3 min, 7 tool calls, ok)
recent errors: none
```

## 10. Logs

- `~/.phone-jarvis/log/daemon.log` - rotated daily, kept 7 days. Connection events, errors, sandbox violations.
- `~/.phone-jarvis/audit/<date>.jsonl` - one JSON object per tool call. Kept 30 days.
- Both are user-readable, group-deny, world-deny (mode 0600).

## 11. Choice of language: Node.js

Settled on Node.js 20+ for the daemon, packaged as a single binary via `bun build --compile` or `pkg`.

Rationale:
- Best WebSocket libraries (`ws`).
- Cross-platform fs APIs are a known quantity; ripgrep wrapping is one shell call.
- Single-binary distribution works cleanly on win/mac/linux.
- Aligns with the desktop Jarvis runtime which is also Node.
- TypeScript for typed tool schemas.

Python was the runner-up. Single-binary on Windows is messier (PyInstaller, antivirus false positives, slower startup). We pick Node and move on.

The cloud service stays Python because Pipecat is Python-first.

## 12. What the daemon explicitly does NOT do

- Does not open any inbound port.
- Does not store call transcripts. Transcripts live in the cloud audit log only.
- Does not phone home to anyone except the configured cloud URL.
- Does not auto-update. User runs `phone-jarvis update` manually.
- Does not have a UI. Status is via `phone-jarvis status` and the log files.
- Does not do anything cute. It is a leashed worker. That is the whole job.
