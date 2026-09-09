# Desktop Link, Jarvis lighting, Deepgram, benchmarks and news

Audit date: September 8, 2026 (America/Chicago). Work started from commit `3cdd8e2b` on `integration/UnifiedChungus-final`.

## Scope and boundaries

Changes cover the requested edge lighting, Deepgram connection checks, separately named packaged MCP, hourly benchmark refresh and native news/benchmark access. Earlier Settings padding, plugin logo, Workbench Faster Agents and Command Center changes are included in the commit review. Chat, RLM and SiYuan context-map source changes are excluded. Existing peer changes and the original Desktop Commander installation are preserved.

This is not an all-green launch certification. Focused checks and live service evidence are distinguished from blocked acceptance below.

## Jarvis lighting

Compared both supplied recordings. The previous renderer used narrow strokes and bright moving cores. The replacement uses four smooth inward gradients and three diffuse moving color fields, with transparent gradient ends and a 450 ms entrance fade. Existing blue/purple/teal colors and yellow/red alert pulses are retained. Explicit close remains immediate; reduced-motion rendering and real microphone/playback energy boundaries remain intact.

The original repository is [Omarchy Ambient Agent](https://github.com/fjalvarezdd/omarchy-ambient-agent). Its configuration exposes border/glow width, opacity, radius, colors, animation periods and completion timeout. Its Linux/Quickshell implementation is a visual reference, not a Windows runtime dependency. The new renderer intentionally removes the sharp border to follow the latest recording request.

The localhost loop continues to bundle the actual application renderer. It is a preview artifact, not evidence of native overlay acceptance.

## Deepgram

The assigned native app reproduced a network failure while a key was configured. Two problems were identified:

- Key tests used the project-list endpoint, incorrectly coupling speech-key health to project-management permissions.
- Browser fetch was blocked by the native app's network policy, and the native HTTP capability omitted Deepgram.

Credential validation now uses the documented [authentication test endpoint](https://developers.deepgram.com/guides/fundamentals/authenticating). Project metadata remains optional. Credential tests and synthesis use the existing native HTTP transport, with a scoped Deepgram host allowance in the main and Workbench capabilities. Tests retain stored keys on temporary failures and never publish credential values.

The rebuilt assigned executable was subsequently checked through its own Tauri WebView: the saved key returned `configured: true, health: connected`. No credential value was logged. This verifies authentication, not every possible speech operation.

## Separately named MCP

The new server identifies as `vibespace-desktop-link`. Its runtime and state are isolated from the existing Desktop Commander. The app detects its connection file automatically; the guided setup saves progress and protects runtime credentials with Windows DPAPI.

Verified through the real isolated package:

- MCP initialization and 27-tool inventory.
- Reading an isolated verification file.
- Opening an isolated Microsoft Edge browser session at Example Domain.
- Native app detection of the package, connection file and 27 tools.
- Saved tunnel ID with truthful missing-runtime-key status.

Windows extraction exposed duplicate ZIP entries differing only by slash direction. The corrected archive has 19,960 unique normalized paths, and the separate extracted package has no missing archive files. Runtime/source hashes were refreshed. Private state is excluded from the release archive.

The browser wrapper deliberately denies `close` and global shutdown; the attempted close was rejected rather than reported as successful. This restriction was preserved. Tunnel authentication and ChatGPT attachment remain unverified until a runtime key is entered through the protected setup UI. A `tunnel_…` value is an identifier, not that API key. No recording of secret credentials is included.

## Benchmarks

Read the live backend at 02:21 UTC September 9. It returned 633 rows and a successful 02:07:20 UTC ingestion, with all four source pages received. GPT-6 Astra (max) was rank 3, index 52.8; GPT-5.1 (high) was rank 128, index 24.7. The [Artificial Analysis Astra page](https://artificialanalysis.ai/models/gpt-6-astra) independently showed rank 3 and rounded index 53. No score or model ranking was invented or manually promoted.

The active benchmark page lacked an hourly timer. It now refreshes while open every hour, retains focus refresh and removes its timer on unmount. Native feed access uses the existing HTTP transport with an allowance limited to the configured default news-worker host. User-defined alternative hosts still require their corresponding native permissions.

## News

The production worker configuration schedules ingestion at minute 7 of each hour. The live endpoint's last completed run was 02:07:28 UTC; 40 items were stored. Six sources succeeded and six failed in that run, so the endpoint correctly reported degraded freshness.

The sampled article [The Work Now Within Reach](https://openai.com/index/the-work-now-within-reach/) matched the feed's September 8 date and title on OpenAI's site. This checks a real published item against the current hourly dataset; it does not establish complete coverage of every publisher.

Source-health data reports broken feeds including Anthropic RSS (404), Microsoft AI blog (410), several YouTube feeds (404), and some empty/malformed release feeds. These are outstanding ingestion issues; they are not hidden by a green status. No production worker deployment or source-data mutation was performed during this check. A full elapsed-hour observation has not yet been completed.

## Verification status

Focused Deepgram tests: 20 passed. Benchmark/news focused tests: 29 passed, including hourly refresh and stale/degraded display. The final expanded run passed 67 tests across 12 files. All 45 release-manifest tests passed. Production typecheck/build passed; Vite bundling completed in 1m 28s. Native compilation passed with existing warnings.

The assigned development executable needed its existing port 5174 specified during compilation; the default port 5173 produced a launch error and a native-permission origin mismatch. The corrected build passed in 3m 18s and reopened at the proper native development URL. Quick checks then returned: Deepgram connected; 633 fresh benchmark rows with `fromCache: false`; 50 news items with truthful degraded freshness. No MCP-through-chat test was performed.

Source changes were committed as `909b65c5` (165 owned files, including earlier fixes). The assigned executable was updated, its previous binary preserved for rollback, and its final test process closed. Other VibeSpace instances were not stopped. The isolated connector's saved-state location remains discoverable across native reconnects.

A broader app suite was started and stopped after seven failing files were recorded, including Chat/runtime areas explicitly excluded by the user. Those failures were not repaired or silently ignored. Earlier successful checks for Settings padding, 112 bundled logos, Workbench selection and Command Center availability remain historical evidence until separately exercised in the rebuilt app.

Remaining acceptance: native overlay visual approval, completed authenticated tunnel/ChatGPT attachment, full news-source recovery, Notes work held by another active owner, and a fully passing whole-app suite. The user will supply the tutorial video. This chat currently exposes no VibeSpace Desktop Link tools; a local MCP test is not equivalent to a ChatGPT-side connection test. Custom ChatGPT app registration and public directory submission are separate from an OpenAI-published official plugin.
