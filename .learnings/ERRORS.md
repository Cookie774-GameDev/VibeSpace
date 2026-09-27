# Errors

## [ERR-20260925-R27] Native RLM probe and local IndexedDB loss

**Logged**: 2026-09-25T03:21:16Z
**Priority**: critical
**Status**: pending
**Area**: tests

### Summary
The idle RLM probe required an in-memory observed execution authority before a new tool call. During a later send attempt, the official native chat lost its IndexedDB records.

### Error
`active_observed_execution_required` at probe preflight; the attempted send subsequently raised `DexieError2`. The WebView IndexedDB log reports that `http_localhost_5173.indexeddb.leveldb` was recreated at 2026-09-24 22:07:02 local because it was missing. A read-only count found 1 chat, 0 projects, 0 Context Maps, and 0 Context entities. The deletion cause is not established.

### Context
- Official C1 PID 25284, WebView profile `C:\Users\viper\AppData\Local\ai.jarvis.desktop\EBWebView`, CDP 9223.
- The prior RLM chat and map were present for the successful native pointer check at 03:00 UTC. That receipt remains at `work/plan1-R27-G7M4/native-preread-authority-1790305199369.json`.
- The post-failure read-only snapshot is `work/plan1-R27-G7M4/native-db-loss-observation.json`.
- No probe pass or 200-call pass was claimed. Further provider submissions stopped pending diagnosis.

### Suggested Fix
Separate idle route validation from active-call authority proof in the guarded test runner. Identify the exact IndexedDB deletion trigger before further tests in the normal user profile; preserve profile data and retest in a truly isolated profile if needed.

### Metadata
- Reproducible: unknown
- Related Files: `work/plan1-R27-rlm-resume/native-preflight-root-lease.cjs`, `work/plan1-R27-rlm-resume/investigate-probe.cjs`, `app/src/lib/doctor/storageDoctor.ts`

---

## [ERR-20260925-X9M2] Desktop Commander ripgrep unavailable

**Logged**: 2026-09-25T04:10:51Z
**Priority**: low
**Status**: pending
**Area**: infra

### Summary
The initial repository search command failed because rg is not on the Desktop Commander PowerShell process PATH.

### Error
```
rg : The term 'rg' is not recognized as the name of a cmdlet, function, script file, or operable program.
```

### Context
- Command: rg -n -i ... against the active coordination-lock directory and docs/AGENT_COORDINATION.md.
- Environment: powershell.exe started through Desktop Commander in C:/Users/viper/VibeSpace-UnifiedChungus-Final.
- The repository search connector was used as the workaround; source inspection and tests continued.

### Suggested Fix
For Desktop Commander sessions on this host, check whether rg resolves before calling it. Use the local search connector when it is unavailable, or invoke a verified absolute rg.exe path.

### Metadata
- Reproducible: yes in the Desktop Commander PowerShell environment
- Related Files: none

---

## [ERR-20260926-RL1] plugin3_sse_probe_unavailable

**Logged**: 2026-09-26T22:22:44Z
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary
Plugin 3 MCP filesystem/browser probes were unavailable during the Relay implementation startup.

### Error
```
SSE probe returned HTTP 429 for list_directory and HTTP 404 for browser_session.
```

### Context
- The user explicitly requested Plugin 3 for the current VibeSpace implementation.
- Local repository and CDP 9223 checks continued through shell and native Playwright after recording the tool failure.
- No Plugin 3 result was treated as successful evidence.

### Suggested Fix
Retry only when the service is available; use the repository's authorized local/native tools for read-only and implementation work in the meantime.

### Metadata
- Reproducible: unknown
- Related Files: work/agent-relay-lean-20260926/TEAM_LOG.md

---
## [ERR-20260927-RL2] relay_room_profile_enrichment_masked_live_room

**Logged**: 2026-09-27T01:10:00Z
**Priority**: medium
**Status**: resolved
**Area**: native-ui

### Summary
Optional local profile enrichment rejected during a native room refresh, causing the panel to show Offline although the authenticated Relay room and linked reply were available.

### Resolution
Keep profile enrichment best-effort at the Workbench boundary. The room still renders verified upstream messages and uses “Not shared” for unavailable profile fields. Native Playwright then showed the linked OpenCode reply, owner post and clickable profile.

### Metadata
- Reproducible: observed on C1 after restart
- Related Files: `app/src/features/workbench/WorkbenchFabric.tsx`, `app/src/lib/relay/relayNativeRoomClient.ts`, `work/agent-relay-lean-20260926/root/native-relay-final-visual.log`

---

## [ERR-20260927-RL3] concurrent_frontend_build_changed_tauri_assets

**Logged**: 2026-09-27T01:10:00Z
**Priority**: medium
**Status**: resolved
**Area**: build

### Summary
A separate frontend build replaced hashed Vite files while release Tauri compilation embedded the dist directory; `tauri::generate_context!` failed to read a removed asset.

### Resolution
Run the MSI build serially against a stable dist directory after the frontend build completes. Preserve the failed log and verify the resulting installer before reporting its size.

### Metadata
- Reproducible: observed once during concurrent builds
- Related Files: `work/agent-relay-lean-20260926/root/release-msi-build-final.log`, `work/agent-relay-lean-20260926/root/release-msi-build-stable.log`

---
