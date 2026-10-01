---
title: MonoChrome migration and rollback
themeStoreKey: jarvis-ui
themeStoreVersion: 5
rollbackTarget: default
privacy: repository-relative implementation evidence only
---

# MonoChrome migration and rollback

MonoChrome replaces Light as the fourth selectable appearance without
changing user content, account data, project state, or unrelated UI
preferences. The canonical source is
`app/src/features/appearance/themeContract.source.json`; generated TypeScript
and the prepaint asset must remain synchronized with it.

## Forward migration

The persisted UI envelope remains under `jarvis-ui` at store version `5`.
The v4 → v5 migration preserves every unrelated preference, including future
keys that the current application does not yet interpret, while normalizing
only its theme value. Migrations from envelopes older than v4 intentionally
retain their existing safe-key subset before the v4 → v5 step runs.

The exact legacy normalization is:

- `light` → `monochrome`
- `dark` → `default`
- `system` → `default`
- canonical `jarvis`, `vibespace`, `default`, `monochrome`, `sakura`, `warm`,
  and `origami` remain canonical
- unknown, malformed, empty, or non-string values → `default`

The selectable order is `jarvis`, `vibespace`, `default`, `monochrome`,
`sakura`, `warm`, `origami`. Migration is idempotent: applying the same
normalization again does not alter the canonical result or any unrelated
state.

## Current-version validation

Version migration alone is insufficient because a malformed value can already
exist inside a version-5 envelope. `mergePersistedUiState` therefore validates
the persisted theme on every hydration, including store version `5`. The merge
retains current values only when the persisted payload omits them and restores
current function-valued methods after the merge. It does not claim to preserve
a non-function runtime-only field when a persisted payload supplies the same
key. A malformed persisted root falls back to the current state with theme
`default`; it does not replace methods or synthesize user records.

Quota recovery in `safeLocalStorage` writes a canonical version-5 fallback
envelope. It keeps the surviving UI fields, normalizes the theme with the same
contract, and does not rewrite application databases.

## First paint and detached-window compatibility

`app/public/theme-prepaint.js` is generated from the same theme contract and
runs before React. It normalizes legacy values before applying
`data-theme`/`data-theme-preference`, preventing a Light or Default first-paint
seam. Pixel Pet surfaces stay transparent during that prepaint path.

Theme synchronization publishes canonical values. Inbound detached-window
messages accept the seven canonical identifiers plus the exact legacy `light`
value, which normalizes to MonoChrome. Invalid legacy values are rejected, and
listener cleanup prevents duplicate subscriptions or echo loops.

## User-data non-impact

The migration changes one UI preference in one local persistence envelope. It
does not enumerate, rewrite, move, or remove chats, messages, projects,
Canvas documents, files, credentials, provider configuration, billing state,
or account records. Rollout and rollback must never delete user data. CSS
imports, document attributes, and terminal palette resolution affect
presentation only; explicit per-terminal and ANSI colors keep their higher
precedence.

## Compatibility-first rollback

A safe rollback is a forward compatibility change, not a historical state
rewind:

- rollback compatibility mapping: `monochrome` → `default`
- rollback legacy compatibility mapping: `light` → `default`

1. Deploy compatibility normalization that accepts both persisted
   `monochrome` and legacy `light`, mapping each to `default`.
2. Preserve `jarvis-ui`, every unrelated preference, and the application data
   stores. If the persisted contract changes, advance its version; never
   decrement or erase the envelope.
3. Keep an inbound sync compatibility window in which detached windows accept
   `monochrome` and `light` but normalize both to `default`. Outbound messages
   remain canonical.
4. Land that compatibility normalization before removing the MonoChrome
   registry/CSS entry, so an older window or stored value cannot apply an
   unsupported document theme.
5. Regenerate the theme contract TypeScript and prepaint artifacts from the
   amended canonical source, then run their synchronization and CSP/order
   contracts.
6. Remove MonoChrome-only presentation assets only after the compatibility
   tests and preserved-theme checks pass.

The rollback must not resurrect Light as a selectable theme. A blanket revert
of the broad MonoChrome commit range is prohibited because the range also
contains shared migration, accessibility, manifest, shell, and regression
work. Use an exact reviewed path manifest and a compatibility commit instead.

## Rollback verification matrix

| Input and boundary                                     | Expected result                            | Required proof                                         |
| ------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------ |
| v4 persisted `light` during the forward release        | MonoChrome                                 | migration deep-equality test; unrelated keys unchanged |
| v5 persisted `monochrome` during rollback              | Default                                    | rollback migration plus hydration integration          |
| v5 legacy `light` during rollback                      | Default                                    | compatibility normalization test                       |
| malformed or unknown persisted theme                   | Default                                    | table-driven migration and current-version merge tests |
| any current canonical theme identifier                 | unchanged                                  | seven-theme canonical matrix                           |
| pre-React persisted value                              | canonical document theme before React      | generated prepaint DOM test                            |
| detached legacy/current message                        | normalized once, no echo, listener cleaned | sync lifecycle integration                             |
| explicit terminal or ANSI palette                      | explicit value wins                        | terminal resolver regression                           |
| chats, projects, Canvas, account, and provider records | byte/logically unchanged                   | scoped persistence and repository tests                |

Rollback acceptance also reruns the generated-contract test, UI-store migration
and merge tests, safe-storage fallback tests, prepaint integration, detached
sync lifecycle, Appearance and command aliases, terminal palette precedence,
other-theme baselines, Origami isolation, typecheck, and the production build.
A screenshot alone cannot establish migration safety.

## Baselines and provenance

The canonical theme and persistence foundation is commit `12198b85`. The
scoped MonoChrome CSS and terminal palette foundation is `ba92a75a`. Startup,
sync, commands, and Appearance integration are based on `8bd1e58c`.

The immutable pre-MonoChrome B0 source commit is
`7eb708e184ee4f054a49d3e70d73e80fd4eb97ae`. Route derivation is frozen at
`041c914da680d4ee5d5c091573e5582b17f18484`, and the route-manifest SHA-256 is
`cf8f766056f9f5bb318d383394f14b5d4e11ec498fa55b1c47ef78f602a81796`.
These identifiers are evidence anchors, not instructions to rewind the branch.

The currently verified forward range is
`12198b85..10ade2cb205be6aae93e239e8debd9eaf584b6de`. This records the
accepted checkpoint used by the proof manifest; it is not a claim that MC9 is
accepted. The final accepted endpoint remains `NOT_RUN` and must be populated
only after the integrated implementation and its complete acceptance matrix
pass.

## Machine-readable proof manifest

The hashes below bind the migration claims to the current immutable proof
inputs. Updating any proof file requires a deliberate manifest update and
fresh review.

```json migration-proof
{
  "schemaVersion": 1,
  "forwardVerifiedRange": "12198b85..10ade2cb205be6aae93e239e8debd9eaf584b6de",
  "currentVerifiedEndpoint": "10ade2cb205be6aae93e239e8debd9eaf584b6de",
  "finalAcceptedEndpointStatus": "NOT_RUN",
  "finalAcceptedEndpoint": null,
  "rollbackContract": {
    "orderedSteps": [
      "normalize-persisted-values",
      "preserve-user-data-and-preferences",
      "keep-sync-compatibility-window",
      "remove-registry-css-after-normalization",
      "regenerate-contract-artifacts",
      "remove-presentation-assets-after-proof"
    ],
    "prohibitedSemantics": [
      "delete-user-data",
      "registry-css-before-normalization",
      "resurrect-light",
      "blanket-revert"
    ]
  },
  "proofFiles": [
    {
      "path": "app/public/theme-prepaint.js",
      "sha256": "CDDBC29C52ED687401896E55FDAF37C531D5AA46D4F7AAAA5CED8B3F7B527F8C"
    },
    {
      "path": "app/src/features/appearance/themeContract.generated.ts",
      "sha256": "36CDF51D5ED5554B5B217967F0D15FC6018B90C0C501286301D0C67ECEF1F6C2"
    },
    {
      "path": "app/src/features/appearance/themeContract.source.json",
      "sha256": "C42C61DD42218DCBE146389A7636475828E5516919AEE067A347E3BA9ECBC1B0"
    },
    {
      "path": "app/src/features/appearance/themePrepaint.integration.test.ts",
      "sha256": "B24A7D096577681EAEB1308AAC2AC8312C8AE33711F43EA500D7869D7BA20F83"
    },
    {
      "path": "app/src/features/appearance/themeSync.test.ts",
      "sha256": "D8806470D48F5C3026AC6802E3156BBFDE55C47569B628F30E2F94BEF86330DA"
    },
    {
      "path": "app/src/features/terminals/terminalTheme.test.ts",
      "sha256": "A946D4B05216F4D7582551F50A4FD48ED304C4439E46BB9D88AA43475626FFBD"
    },
    {
      "path": "app/src/lib/persistence/safeLocalStorage.test.ts",
      "sha256": "C00A0E3AC2117E7ACDDAEF2F34ABA286F6D884C69CD51F27192DB99D09F71586"
    },
    {
      "path": "app/src/stores/ui.themePersistence.test.ts",
      "sha256": "C8E6514950B56B37F4E5401A2FB56283411B4A0D1506A843F254D26A035E4E0F"
    }
  ]
}
```
