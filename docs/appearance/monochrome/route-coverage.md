# MonoChrome route coverage

Schema: 2
Derivation commit: 041c914da680d4ee5d5c091573e5582b17f18484
B0 source commit: 7eb708e184ee4f054a49d3e70d73e80fd4eb97ae
B0 route-manifest SHA-256: cf8f766056f9f5bb318d383394f14b5d4e11ec498fa55b1c47ef78f602a81796
Production routes: 18
Settings tabs: 18
Coverage entries: 85

The executable authority is `tests/visual/monochrome/route-manifest.ts`. This document is the
operator summary; the focused test checks its counts, schema, derivation commit, and lane rows
against that authority.

## Source-derived closure

`Route` and `PageRouter` agree in this exact order:

`chat`, `canvas`, `workbench`, `preview`, `browser`, `terminal`, `kanban`, `schedule`, `agents`,
`agent-detail`, `project-detail`, `context`, `skills`, `benchmarks`, `history`, `tools`, `files`,
`account`.

The settings dispatch closes over:

`plans`, `providers`, `connections`, `hive`, `allaboutme`, `plugins`, `localmodels`,
`appearance`, `voice`, `composerstt`, `phone`, `ambient`, `notifications`, `accessibility`,
`hotkeys`, `jarvisactions`, `admin`, `about`.

The 85 entries comprise 18 routes, 18 settings tabs, 3 access surfaces, 31 shell/overlay
surfaces, 4 detached views, 6 native windows, 3 embedded surfaces, 1 development-only surface,
and 1 unavailable future surface. Shell/overlay and detached closure is imported from the
committed shell authority; native closure is imported from the committed native-window
authority. Every available entry records literal source and test paths, fixture ID and SHA-256,
functional command, 1672×941/1024×768/narrow-desktop viewports, 100%/125%/150%/200% zoom,
normal/reduced-motion states, preserved-theme B0 case IDs, owner, logical lock, and literal file
locks.

Functional evidence is explicit rather than overstated. 37 available entries have a direct
feature or surface Vitest command. The remaining 47 available entries currently lack a
narrower committed behavioral suite and therefore name the single-worker full application
regression command as a fail-closed aggregate fallback. Structural route, shell, and native
manifest commands are supplementary only; no available entry relies on one as its sole
functional command. MC7 must add its focused RED style assertion and retain the recorded focused
or aggregate behavioral evidence.

`future:messaging-channels` is intentionally `unavailable`: current source has billing copy and
plugin capabilities, but no production messaging/channel-management visual surface. It has no
source or writer path and cannot be treated as passed. `embedded:browser-operator` is an audited
behavioral alias of the Browser route and owns no second writer path. The MC4 primitive
workbench is recorded as `development-only`, is not in `Route` or `PageRouter`, and remains
read-only to MC7. The three Access host/banner/locked entries are explicitly
`feature-flagged`; they remain required audited production surfaces even when the runtime flag is
off. `settings:hive` is also `feature-flagged` (scrapped Hive product gate; revive with
`VITE_HIVE_ENABLED=true` — see `docs/HIVE_PRODUCT_GATE.md`).

## Frozen MC7 lanes

The literal `writerPaths` arrays in the executable manifest are the file-lock authority. Paths
listed as shared read-only—especially `ui.ts`, `PageRouter.tsx`, layout, primitives, styles,
registries, the visual harness, detached/native dispatch, and B0 authorities—belong to no MC7
writer.

| Lane | Surface entries                                                                        | Writer boundary                                          | Logical lock      |
| ---- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------- |
| MC7A | Chat; Command Center; assistant, call, command-palette, dictation, and voice overlays  | Seven literal feature component paths                    | `monochrome:mc7a` |
| MC7B | Context, Terminal, Workbench, Files, file explorer                                     | Five literal feature page/dialog paths                   | `monochrome:mc7b` |
| MC7C | Agents/detail, Skills, Tools/plugins, actions palette                                  | Five literal feature component paths                     | `monochrome:mc7c` |
| MC7D | Prompt Forge and Canvas                                                                | Two literal feature component paths                      | `monochrome:mc7d` |
| MC7E | Browser Chat and Browser Operator; messaging/channels unavailable                      | `BrowserPage.tsx` only                                   | `monochrome:mc7e` |
| MC7F | Account Center, usage, billing/plans, providers, access, Settings and all 18 tabs      | Twenty-five literal account/access/settings/plugin paths | `monochrome:mc7f` |
| MC7G | History, Kanban, Schedule, Preview, project detail, benchmarks, and remaining overlays | Seventeen literal route/overlay paths                    | `monochrome:mc7g` |

MC5 retains ten shared shell/layout/primitive entries. MC9 retains detached/native audit and
dispatch. MC4 retains the development-only workbench. No MC7 lane may add a shared primitive,
layout, stylesheet, registry, or visual-harness path without a new independently reviewed
manifest amendment.

## Resumption and evidence

Run:

```text
node --test tests/visual/monochrome/route-manifest.test.ts
```

The validator fails closed on missing production routes, settings, or access surfaces; duplicate
IDs; unstable entry order; unknown route IDs; nonexistent available source/test paths; fixture
hash drift; source-derived route/router/settings authority drift; extra, aliased, missing, or
mis-namespaced route/settings entries; missing, malformed, mismatched, or structural-only behavior
commands; missing preserved-theme baselines; file-lock mismatch; writer overlap; and false
unavailable classifications. Route styling remains blocked until the parent accepts this literal
manifest and records the corresponding lane lock.

Preservation is contractual: the fixture hashes and B0 baseline case IDs remain tied to Default,
VibeSpace, Jarvis Core, and the separate frozen Origami chat case. MC7 may change appearance only
under the MonoChrome selector; it must not reorder the four selectable themes or change behavior,
copy, product data, access truth, or other-theme rendering.
