# PR31 VibeSpace, Sakura, and Origami Theme Deferral

## Outcome

VibeSpace, Sakura, and Origami are deferred from the current release without deleting or
redesigning their implementation. The authoritative theme contract keeps their full metadata,
document-theme mapping, source code, styles, tests, and local assets available for a future
release, while the current release exposes only:

1. Jarvis One
2. Default
3. MonoChrome
4. Warm

## Current release boundary

- Settings → Appearance, `/appearance`, and `/themes` list exactly the four release appearances.
- Persisted `vibespace`, `sakura`, and `origami` preferences normalize to `default`.
- Startup prepaint applies `default`/`dark` for any stale deferred preference.
- Cross-window sync ignores VibeSpace, Sakura, and Origami messages.
- Global command aliases for VibeSpace, Sakura, and Origami are unavailable.
- `/theme` remains the scoped chat/code-output syntax-theme picker and does not expose deferred
  global app designs.

## Preserved future-release implementation

No file in these design boundaries was changed or deleted by the deferral task:

- Sakura: `app/src/styles/sakura-theme.css`,
  `app/src/components/layout/sakura-shell.css`, and
  `app/src/features/appearance/sakura/**`
- Origami: `app/src/styles/origami-theme.css`,
  `app/src/features/chat/OrigamiChatDecor.tsx`,
  `app/src/features/chat/OrigamiChatDecor.test.tsx`,
  `app/src/features/chat/origamiWelcome.ts`,
  `app/src/features/chat/origamiWelcome.test.ts`, and
  `app/public/assets/themes/origami/**`
- VibeSpace: `app/src/styles/vibespace-theme.css`,
  `app/src/styles/origami-chat.css`,
  `app/src/features/chat/OrigamiChatDecor.tsx`,
  `app/src/features/chat/OrigamiChatDecor.test.tsx`, and
  `app/public/assets/origami-chat/**`

Preservation manifest summaries:

| Theme     | Files |   Bytes | SHA-256                                                            |
| --------- | ----: | ------: | ------------------------------------------------------------------ |
| Sakura    |    19 |  93,836 | `f66ab4a38e17faceaa3dc408e26fa805b8bf72d7637ffaaf99ca97e14f7ed1fa` |
| Origami   |     8 |  38,116 | `dad2895b84cb5a08de0d6c90112e7c759a02f44f75fdc40f7b11e614b623f775` |
| VibeSpace |    15 | 367,029 | `d9de49078a5b7b44abfe41701e24861efb05a0f0154fa20b88012e459a899df5` |

The SHA values are deterministic hashes of sorted `relative-path|file-sha256|size` manifest
rows. They provide a compact integrity reference for the future release handoff.

## Roll-forward

A future release can restore exposure by removing the intended identifiers from
`deferredThemes` in `app/src/features/appearance/themeContract.source.json`, regenerating the
theme contract, and rerunning the focused theme, persistence, Settings, typecheck, build, and
visual acceptance lanes.

## Rollback

Re-add the intended identifiers to the release surface by removing their `deferredThemes` entries and
regenerating. No design-source restoration is necessary because the design implementation was
preserved in place.

## Verification

- RED: the focused suite first produced 18 expected failures while VibeSpace was still
  release-selectable and the keyboard-first code preview pickers were incomplete.
- GREEN: the final focused release-boundary, sync, and command-picker suite passes 85/85 tests
  across ten files.
- The generated theme contract freshness check, TypeScript check, and production build pass.
- The production build transformed 4,195 modules and retained only its existing non-failing Vite
  dynamic/static-import and large-chunk warnings.
- No running VibeSpace app process was closed or restarted, and no external system was mutated.
