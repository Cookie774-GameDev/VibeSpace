# Browser Chat

Browser Chat is a second chat mode alongside native VibeSpace Chat. It opens
the real ChatGPT, Claude, or Gemini consumer website inside an isolated,
provider-specific desktop webview when the desktop runtime supports it. A
system-browser fallback is always available.

## Trust boundary

- The provider owns its page, authentication, subscription, limits, and data.
- Each provider receives a separate local browser profile.
- Provider webviews are not granted VibeSpace Tauri IPC capabilities.
- VibeSpace does not inspect the provider DOM, intercept network traffic,
  capture cookies, scrape conversations, or turn subscriptions into APIs.
- Page status and local-tool/MCP bridge status are separate. A loaded provider
  page never implies that tools are connected.

Use the Chat Modes control in the top-right application bar to switch between
native VibeSpace Chat and Browser Chat. Switching modes does not change the
selected VibeSpace model or native-chat history.

## Current behavior

- Supported provider pages: ChatGPT, Claude, and Gemini.
- Desktop: a borderless child webview is aligned to the Browser Chat content
  region and remains scoped to the VibeSpace window.
- Web build: the provider opens in the system browser.
- Failure: the hub preserves the provider account and offers the same
  system-browser fallback with the actual error.

Tool bridges remain disabled unless a separately verified, provider-supported
integration is configured. VibeSpace does not simulate a bridge.
