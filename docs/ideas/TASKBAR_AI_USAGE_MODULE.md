# VibeSpace Taskbar AI Usage Module — Production Repair and Expansion

**Status:** Required implementation/repair
**Goal:** `VS-PR31-PRODUCTION-FUNCTIONALITY-20260802`
**Target:** VibeSpace desktop, Tauri + React/Vite

## Problem statement

The usage-module setting can be enabled while no module appears. An enabled-but-invisible feature is a production bug. The setting, window lifecycle, placement, persistence, provider data, theme state, and cleanup must be connected end to end.

The module must be fully automatic: it reuses connections and activity already known to VibeSpace. It does not ask the user to enter the same key, choose a duplicate provider, or perform manual synchronization.

## Product contract

- One tiny taskbar-adjacent companion window.
- Exactly two provider rows in normal view: the user's top-ranked two visible providers.
- Fixed compact bounds; no layout growth when values update.
- Theme-adaptive across every VibeSpace appearance.
- Local request activity is live and event-driven.
- Aggregate state reconciles at least every five seconds while enabled.
- Remote quota requests use safe provider-specific intervals and caching rather than polling all providers every five seconds.
- At least thirty provider families are supported through a data-driven adapter registry.
- Quota is shown only when an authoritative supported source exists.
- One provider failure cannot break the module.
- Disabling the module stops all background work and closes the window.

## Reference direction

Preserve the approved compact usage-module direction: small type, thick short progress bars, restrained provider accents, and a taskbar companion feel. The reference's four rows are not the final density; normal mode shows only two rows. Appearance varies through semantic tokens, not separate hardcoded components.

## Window lifecycle

### Enable

When `Show taskbar usage module` becomes enabled:

1. persist the preference;
2. obtain or create the single native window;
3. validate saved display/edge/offset;
4. recover off-screen or invalid placement;
5. load normalized cached snapshots;
6. subscribe to request and connection events;
7. start the reconciliation coordinator;
8. show the window;
9. return a verified visible/running status.

The settings toggle must not remain on when creation fails without also showing a clear degraded/error state and Retry/Reset Position action.

### Disable

When disabled:

1. unsubscribe from all events;
2. abort in-flight quota refreshes owned by the module;
3. stop timers/backoff schedules;
4. flush ordering/placement/cache metadata;
5. close or destroy the module window according to the chosen lifecycle;
6. publish disabled status.

### Single instance

Use a stable native window label. All operations are idempotent. Stale handles are detected and recreated. Repeated toggles cannot create duplicate windows or duplicate subscriptions.

### Visibility recovery

Recover automatically when:

- the saved monitor no longer exists;
- DPI/work area changed;
- taskbar edge changed;
- a laptop monitor disconnected;
- saved coordinates are outside every work area;
- the native window was closed externally;
- the app restored from an older invalid placement schema.

Clamp to a visible safe default adjacent to the current primary taskbar. `Reset position` always works.

## Compact layout

Recommended maximums:

- collapsed strip: about `280 × 36 px`;
- expanded compact panel: about `340 × 128 px`.

Normal contents:

- live/fresh/stale/offline indicator;
- total active VibeSpace AI requests;
- top provider row;
- second provider row;
- compact expand/reorder control.

Each provider row:

- provider name;
- connection/activity status;
- thicker short progress bar only when usage percent is authoritative;
- compact amount/percent or `Quota unavailable`;
- optional requests-per-minute/active-request metric;
- stable fixed-width numeric columns with tabular numerals.

No bar is rendered from guessed data.

## Settings

Keep one compact section under the existing appropriate General/Usage area:

1. `Show taskbar usage module`
2. `Launch with VibeSpace`
3. `Provider order`
4. `Hidden providers`
5. `Reset position`
6. small verified status: running, stopped, degraded, or error

Do not create a second provider connection manager inside this section.

## Theme contract

Consume live semantic appearance tokens from the canonical appearance store. At minimum map surface, elevated surface, border, primary text, muted text, accent, success, warning, danger, shadow, and radius.

Requirements:

- update immediately when appearance changes;
- preserve provider logos/brand recognition without overpowering the theme;
- no excessive blur;
- readable contrast in dark, warm, light, Sakura, MonoChrome, and future token-compatible themes;
- forced-colors support;
- reduced-motion support;
- no panel resize during theme changes.

## Data contract

```ts
export type UsageFreshness = 'live' | 'fresh' | 'stale' | 'offline' | 'error';
export type UsageSource =
  | 'local-events'
  | 'provider-api'
  | 'cli-session'
  | 'local-runtime'
  | 'cached';

export interface ProviderUsageSnapshot {
  providerId: string;
  providerFamilyId: string;
  displayName: string;
  connectionMode: 'api' | 'oauth' | 'cli' | 'local' | null;
  connected: boolean;
  hidden: boolean;
  activeRequests: number;
  usageValue: number | null;
  usageLimit: number | null;
  usageUnit: 'requests' | 'tokens' | 'credits' | 'usd' | 'percent' | null;
  usagePercent: number | null;
  requestsPerMinute: number | null;
  updatedAt: number;
  freshness: UsageFreshness;
  source: UsageSource;
  quotaAvailable: boolean;
  errorCode?: string;
}

export interface ProviderUsageAdapter {
  id: string;
  familyId: string;
  detect(signal: AbortSignal): Promise<boolean>;
  getCachedSnapshot(): ProviderUsageSnapshot | null;
  refreshQuota(signal: AbortSignal): Promise<ProviderUsageSnapshot>;
  subscribeToActivity(
    listener: (snapshot: ProviderUsageSnapshot) => void,
  ): () => void;
}
```

## Thirty-plus provider registry

The registry must be data-driven and extensible. Initial family coverage should include, where VibeSpace supports a connection or runtime:

1. OpenAI / Codex
2. Anthropic / Claude
3. Google Gemini
4. Google Vertex AI
5. Azure OpenAI
6. AWS Bedrock
7. xAI
8. DeepSeek
9. Groq
10. Mistral
11. Cohere
12. Perplexity
13. OpenRouter
14. Together AI
15. Fireworks AI
16. Cerebras
17. SambaNova
18. NVIDIA NIM
19. Hugging Face
20. Replicate
21. Cloudflare Workers AI
22. Qwen / DashScope
23. Moonshot / Kimi
24. MiniMax
25. OpenCode
26. GitHub Copilot
27. Deepgram
28. ElevenLabs
29. AssemblyAI
30. Cartesia
31. Ollama
32. LM Studio
33. vLLM or another supported local OpenAI-compatible runtime

A provider definition does not guarantee quota support. Detection and activity may be supported while quota remains unavailable. Do not use private, scraped, undocumented, or user-session web endpoints to fill the module.

## Refresh and performance

### Event-driven path

Every supported VibeSpace request transport emits start, settle, cancel, and failure events. The module aggregates active requests immediately without network polling.

### Five-second reconciliation

While enabled, one shared coordinator wakes no more than once every five seconds to:

- reconcile connection changes;
- merge event state with cached snapshots;
- update freshness;
- schedule due provider refreshes;
- publish one batched UI snapshot.

User actions such as reorder, theme change, enable, or disable may update immediately.

### Remote quota path

- provider-defined safe intervals, typically `15–60 seconds` or longer;
- deduplicate with fresh data already owned by the main app;
- request only connected providers;
- prioritize the two visible providers;
- use jitter to avoid synchronized bursts;
- exponential backoff and circuit behavior after repeated failure;
- abort stale work on disable/account/mode change;
- never send more frequent requests than official limits permit.

### Budget

- idle CPU target below `0.5%` on a typical modern desktop;
- active CPU normally below `1.5%`;
- additional memory target below `35 MB`;
- no continuous window-position polling;
- one renderer update per reconciliation tick at most, except direct user/theme actions;
- no duplicate remote request when a fresh shared snapshot exists;
- no work when disabled.

## Security and privacy

- Raw keys and tokens never enter the taskbar webview.
- Use stable credential/account handles and sanitized metadata.
- Do not display account email/organization unless the user explicitly enables it and the data is already safe for UI.
- Redact provider errors.
- Cache only normalized metrics, provider IDs, ordering, hidden state, freshness, and placement.
- Clear account-specific cached metrics on disconnect/account switch.
- Keep local/BYOK usage separate from shared hosted-company credits.

## States

### No connections

`No AI providers connected` with `Open Connections`.

### Connected, quota unavailable

`Codex · Active · Quota unavailable` while retaining real activity counts.

### Fresh

Show authoritative amount/percent and updated time only when useful.

### Stale

Keep the last valid value and label `Updated Xm ago`.

### Offline

Show cached data plus local activity with `Offline`.

### Adapter error

Show a small warning for that row. Other providers continue.

### Window error

Settings displays the error and offers `Retry` and `Reset position`. Do not silently leave the toggle enabled with nothing visible.

## Persistence

Persist schema-versioned:

- enabled;
- launch-with-app;
- provider order;
- hidden providers;
- monitor identity;
- taskbar edge;
- offset;
- collapsed/expanded state;
- sanitized cached snapshots and timestamps.

Migrate old preference names and invalid geometry safely.

## Required tests

- enabling creates/shows exactly one window;
- disabling closes it and stops timers/subscriptions;
- repeated toggles are idempotent;
- stale window handle recreates;
- invalid monitor/off-screen geometry recovers;
- restart restores when enabled;
- top-two ordering and hidden state;
- keyboard reorder;
- theme token updates without remount/resize;
- five-second reconciliation with fake timers;
- local activity updates without remote polling;
- provider refresh dedupe, jitter/backoff, abort;
- one adapter failure isolation;
- no quota bar when unavailable;
- cached stale/offline behavior;
- no raw secret in IPC/store/log payload;
- browser preview desktop-only state;
- multi-monitor/taskbar auto-hide native smoke;
- resource budget measurement.

## Acceptance criteria

- [ ] Turning the setting on produces a visible module immediately or a clear actionable error.
- [ ] Turning it off removes the module and background work.
- [ ] The module restores after restart and never remains off-screen.
- [ ] Exactly two user-ranked provider rows appear in normal mode.
- [ ] The panel adapts to every appearance using semantic tokens.
- [ ] Live local activity is real.
- [ ] Aggregate state reconciles at least every five seconds.
- [ ] Remote provider APIs are not blindly polled every five seconds.
- [ ] Thirty-plus provider families can register through the same adapter system.
- [ ] Unsupported quota is labeled unavailable, never invented.
- [ ] Existing connections are detected automatically without duplicate setup.
- [ ] One provider failure does not affect others.
- [ ] No secret enters the UI or logs.
- [ ] Performance remains inside the target budget in a real Windows desktop validation.
