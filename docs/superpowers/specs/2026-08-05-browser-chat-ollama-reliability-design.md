# Browser Chat and Ollama Reliability Design

## Outcome

VibeSpace Chat gains two explicit engines: the existing native VibeSpace Chat and a Browser Chat hub. Browser Chat keeps VibeSpace-owned navigation, provider selection, status, privacy explanations, and local session preferences around a real provider-owned ChatGPT, Claude, or Gemini surface. Ollama remains part of native Chat and gains bounded failure handling so a connected daemon cannot leave a send silently pending.

## Browser Chat architecture

- A small persisted `browserChatStore` owns only engine selection, selected provider, managed-surface preference, and per-provider local status.
- `TopBar` exposes one compact Chat Modes control in the top-right cluster. Selecting either mode navigates to the existing `chat` route and changes only the engine.
- `ChatView` preserves its current native tree exactly when the engine is `native`; when the engine is `browser`, it mounts `BrowserChatHub`.
- `BrowserChatHub` supplies provider tabs, page and bridge status, privacy/plan disclosure, managed-window controls, system-browser fallback, and a compact local inspector.
- `providerRegistry` is static, bundled, and allowlisted. It is never downloaded from remote JSON.
- `providerSurface` creates a Tauri `WebviewWindow` only from the trusted main window. Each provider receives a distinct window label and `dataDirectory`; no Browser Chat provider label appears in a Tauri capability, so remote provider pages cannot call VibeSpace commands.
- Provider content is never read, injected into, restyled, scraped, or mirrored. Provider generation state remains provider-owned.
- Web builds show the truthful system-browser fallback instead of simulating a managed provider surface.

## Provider surface support

Initial runtime support is conservative:

- ChatGPT, Claude, and Gemini can open in isolated managed windows on desktop.
- The hub always offers system-browser fallback.
- Tool bridge state is distinct from page state and defaults to provider-specific “not configured” or “unsupported” until an official connection is actually established.
- The feature does not claim official MCP/app publication or read/write access merely because a page loaded.

## Ollama reliability architecture

The current provider already performs daemon readiness and installed-model checks. The missing reliability boundary is a native completion that can wait for the full Rust IPC timeout without visible progress or a bounded frontend settlement guarantee.

The fix introduces a small exported completion guard around native Ollama calls:

- abort settles immediately and ignores late native completion;
- first response has a bounded timeout with an actionable error;
- empty output is rejected;
- one retry is allowed only for a transient transport failure before any output;
- model-not-installed, invalid model, abort, and deterministic provider errors never retry;
- callbacks receive exactly one terminal `done` event;
- no cloud fallback occurs automatically, and Fully Local behavior stays fail-closed.

## Accessibility and performance

- Both engines and all providers are reachable by keyboard and exposed as labeled tabs or menu items.
- Status is text-first and not color-only.
- Managed WebViews exist only while Browser Chat is active; inactive provider windows are hidden, not polled.
- Resize synchronization uses `ResizeObserver` plus animation-frame coalescing.
- No provider DOM observer, background scraper, iframe, or continuous task manager is introduced.

## Rollback

Removing the TopBar control and `ChatView` branch returns native Chat to its prior behavior. Browser Chat storage is isolated under its own key. The Ollama guard is contained in the provider file and can be reverted without changing model selection, prompts, or native commands.
