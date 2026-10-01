# VibeSpace Production Functionality Design

**Goal:** `VS-PR31-PRODUCTION-FUNCTIONALITY-20260802`
**PR:** `Cookie774-GameDev/VibeSpace#31`

## Design intent

The affected VibeSpace surfaces must feel like one product backed by one source of truth. Settings must not merely display controls; every control must bind to a canonical runtime contract. The design uses progressive disclosure, truthful state, semantic theme tokens, and small focused feature boundaries.

## Core architectural rule

Each domain has one canonical service/store and any UI is a projection of that domain state:

```text
secure/native/runtime source
          ↓
canonical domain service + normalized state
          ↓
selectors / sanitized events
          ↓
settings, chat, taskbar module, commands, and status UI
```

No settings section may own a parallel provider connection, credential, usage counter, microphone session, model catalog, or assistant identity.

## Shared status contract

Use a common status vocabulary where practical:

```ts
export type CapabilityState =
  | 'idle'
  | 'detecting'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'unavailable'
  | 'error';

export interface CapabilityStatus {
  state: CapabilityState;
  title: string;
  detail?: string;
  action?: { id: string; label: string };
  updatedAt?: number;
  errorCode?: string;
}
```

The title is brief. Detailed diagnostic information lives behind a details disclosure and is sanitized.

## Provider-family design

Normalize a provider family separately from a connection mode:

```ts
export type ProviderConnectionMode = 'api' | 'oauth' | 'cli' | 'local';

export interface ProviderFamilyState {
  familyId: string;
  displayName: string;
  supportedModes: ProviderConnectionMode[];
  activeMode: ProviderConnectionMode | null;
  modes: Partial<Record<ProviderConnectionMode, ProviderModeState>>;
}
```

One card renders one family. A compact mode switch changes the selected route. Each mode renders only the fields/actions it needs. Legacy IDs map into this contract through a pure migration table.

The runtime routes through `(familyId, activeMode, connectionId)` and never guesses a fallback.

## OAuth connector design

Use one authorization coordinator:

```text
Connect click
  → create bounded authorization transaction
  → store state/verifier securely
  → open provider authorization URL
  → receive validated callback
  → exchange server-side/native-side where required
  → store tokens in secure credential store
  → publish sanitized connected account
```

The UI sees provider, account display name, scopes, connection time, and status. It never sees refresh/access tokens.

## Credential sharing design

Providers, STT, Voice, Phone & Voice, chat, and the usage module subscribe to the same sanitized connection registry. A Deepgram key is stored once and referenced by a stable credential handle. Hosted call services use operator/server credentials and never consume a desktop BYOK key.

## Usage architecture

### Data layers

1. **Local request events:** exact start/settle/cancel events emitted by VibeSpace request transports.
2. **Connection detection:** sanitized provider and CLI/local runtime status.
3. **Remote quota snapshots:** optional provider-specific authoritative API data.
4. **Cached normalized snapshot:** last valid value, freshness, source, and error.
5. **Taskbar presentation:** top-two rows and aggregate activity only.

### Scheduling

- Local activity is event-driven.
- A lightweight coordinator reconciles visible snapshots every five seconds while enabled.
- Provider adapters choose a safe remote refresh interval based on official rate limits and capabilities.
- Requests are cached, deduplicated, jittered, abortable, and backed off after failure.
- Hidden providers may refresh less often unless they are actively processing requests.
- When disabled, the module window, coordinator, subscriptions, and timers shut down.

### Theme adaptation

The taskbar window receives a compact serialized semantic token set from the canonical appearance store:

```ts
interface UsageThemeTokens {
  surface: string;
  elevatedSurface: string;
  border: string;
  text: string;
  mutedText: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  shadow: string;
  radius: number;
}
```

No provider adapter knows about appearance. Provider brand colors are optional small accents and must meet contrast requirements.

### Visibility recovery

At enable, startup, display change, taskbar change, or failed window lookup:

1. enumerate displays/work areas;
2. validate saved monitor and edge;
3. clamp the module rectangle inside the selected work area;
4. recreate a missing/stale window exactly once;
5. move/show/focus only when user action requires focus;
6. persist corrected placement;
7. surface a bounded error if native creation still fails.

## Voice and microphone state design

Use one microphone broker with explicit leases:

```ts
export type MicrophoneOwner = 'click-to-talk' | 'hands-free' | 'global-dictation' | 'call';

export interface MicrophoneLease {
  owner: MicrophoneOwner;
  startedAt: number;
  release(): Promise<void>;
}
```

A new owner either waits, asks the current owner to release, or fails with a clear busy state according to a deterministic policy. The hands-free controller owns wake-word listening and promotes to utterance capture without creating competing `getUserMedia` loops. Click-to-talk never uses the hands-free auto-stop timer.

Assistant identity and voice resolution:

```text
selected assistant profile
       ↓
wake phrases + display labels + action copy
       ↓
eligible selected voice
       ↓
verified runtime/provider
       ↓
explicit fallback with truthful label
```

## Local model lifecycle design

Use manifest-backed installs and atomic state transitions:

```ts
export type ModelInstallState =
  | 'not-installed'
  | 'checking-space'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'repair-needed'
  | 'updating'
  | 'removing'
  | 'error';
```

A model is `ready` only after path resolution, manifest verification, and runtime compatibility. Downloads write to a temporary path, verify, then atomically promote. Repair compares the installed manifest to expected artifacts. Remove deletes both artifacts and canonical metadata after active runtime release.

## Hardware inventory and Build Your Own AI

The browser preview uses a capability placeholder. The installed app obtains inventory through native commands and returns optional values with evidence/source. Training compatibility is a pure rules engine using inventory, free disk, runtime presence, model requirements, and safety limits.

The wizard stages are:

1. Purpose
2. Method selection: RAG, adapter training, or advanced full training
3. Base model
4. Identity/behavior defaults
5. Sources/data
6. Hardware/runtime compatibility
7. Review
8. Build/train
9. Evaluate and export

Unsupported methods remain visible for education but disabled with a concise reason. RAG remains named as knowledge indexing/retrieval, not weight training.

## Ollama/local chat design

A local runtime adapter owns health, model listing, request streaming, cancellation, and timeout policy. The chat layer receives normalized chunks and terminal status. Selection never implies availability; availability is verified immediately before send and may update when the daemon changes.

## Context Map design

Keep one graph domain with nodes, edges, filters, selection, and persisted layout. UI components are:

- graph canvas;
- toolbar/search/filter;
- node details inspector;
- nonblocking nightly-update inspector;
- status/errors;
- keyboard-accessible alternate list/table.

Nightly updates enqueue graph mutations through the same repository/service as manual changes. They do not render an overlay over primary controls.

## Visual system rules

- Preserve the current shell and route structure.
- Use semantic tokens from the active appearance.
- Use concise headings, one-sentence support copy, and progressive disclosure.
- Emphasize actionable state: connected/disconnected, available/unavailable, current route, current model, current voice, and next action.
- Important labels such as API, CLI, OAuth, local, hosted, credits, and desktop-only receive clear visual hierarchy.
- Avoid repeated large cards when a compact grouped list or status summary is clearer.
- No excessive blur, decorative glow, giant empty padding, or generated-looking filler copy.
- The Build Your Own AI and Context Map may use purposeful diagrams/illustrations; other settings changes remain restrained.

## Error design

Errors use stable codes and short user copy. Technical detail is logged only after redaction. Retriable errors expose Retry. Configuration errors expose Configure. Unsupported states expose Learn why or the required valid action. Never collapse invalid credential, network failure, service outage, permission, missing runtime, and insufficient disk into one generic error when the layer can distinguish them.

## Accessibility design

- Every icon-only control has an accessible name and tooltip.
- Dialogs trap and restore focus.
- Status changes announce without stealing focus.
- Drag reordering has keyboard alternatives.
- Graph interaction has an alternate list view and keyboard selection.
- Color is never the sole status signal.
- Reduced motion disables nonessential transitions.
- Forced-colors mode uses system colors and visible boundaries.

## Performance design

- Narrow Zustand/store selectors and stable subscriptions.
- One shared timer per coordinator, not one per row/provider.
- Abort stale async work.
- Pause hidden/inactive surfaces.
- Lazy-load model manager, training, and graph bundles.
- Use virtualization for long provider/model lists.
- Avoid continuous taskbar-position polling; respond to native display/window events.
- Record lightweight development metrics for render count, refresh count, request deduplication, and adapter latency.
