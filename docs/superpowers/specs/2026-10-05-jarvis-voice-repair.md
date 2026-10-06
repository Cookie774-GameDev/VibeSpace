# Jarvis voice repair

Task: VS-A4-VOICE-20261005-V06. Base: 34f87bfc3113ae91da4a417d211e93c4092bcebe, qa/local-workspace-recovery-20261005-1437.

Use the existing configured STT session, voice reply/TTS router, selected connected harness/model, fresh-or-persistent conversation setting and authorized chat creation. Preserve provider, model, reasoning preferences, permissions, account/workspace/project scope and durable history. Keep the current voice HUD and Command Center composition.

## Repairs and regression evidence

- Revalidate a cached voice backing chat before dispatch. A deleted/missing chat must resolve a new authorized chat in the same captured scope; no orphan user message or stale-session reply. Keep one chat per opening in fresh mode, and reuse the persistent voice chat when it exists.
- An explicit saved model within the requested harness must not silently become another model when its exact connected route is unavailable. Keep the selected identity and report the actionable limitation. Cross-harness choices must be explicit and continue to use the existing controls.
- The voice model picker must match the route actually sent. Audit the current all-provider picker versus the Codex/OpenCode voice harness setting; implement only the minimum adjustment proven by a regression.
- On opening with no model selection, initialize the displayed model from an available exact native route after the authorized voice session is bound. Preserve any explicit selection and send no model request during initialization.
- Cover capture startup/cancel, late callbacks, configured STT/TTS routing and cleanup with existing code-only tests. Use no paid provider probes or backend test backdoors.

## Capability and verification limits

Inspect actual installed Codex/OpenCode versions and metadata/schema before describing provider-native voice support. A generated audio/realtime type alone does not establish a supported authenticated voice path or selected-model compatibility. Reuse a genuine available native path only when its actual contract is established; otherwise retain VibeSpace STT/text-harness/TTS and report the missing capability. Agent7 owns native/subagent adapters and must finish its work before any overlapping internal change; these paths remain excluded.

Local audit: managed Codex 0.151 reports realtime disabled; global Codex 0.158 and the installed official desktop CLI 0.160 report `realtime_conversation stable true`. Generated 0.158 experimental bindings expose thread-scoped realtime start/audio methods and a separate realtime model override. The existing resolver can promote a newer trusted official desktop executable; it does not promote an arbitrary npm executable while managed detection is ready. Installed capability is therefore present, but the actual live selected executable, authenticated audio path and compatibility with the user's selected STT/TTS/model remain unverified. No runtime configuration or experimental initialization was changed and no provider request was made.

Root native retest reported an unresponsive official WebView after account reload, with an earlier managed runtime detection timeout/install failure. It did not exercise microphone or audio; code/unit checks cannot resolve that acceptance gate. Preserve the existing app and wait for root's assigned native test evidence.

Run RED regressions before production changes, then focused voice tests, appropriate settings/routing tests, typecheck, formatting, build and repository-required checks. Retain timing and failure receipts; qualify hardware and native acceptance. The user tests the official reopened native app; do not launch/control a duplicate instance. Ask for mic/transcript/reply/audio evidence and leave acceptance pending until received. Preserve previously completed Foundry receipts and its outstanding native acceptance.
