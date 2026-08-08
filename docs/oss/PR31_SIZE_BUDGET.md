# PR #31 Dependency Size Budget

Captured on 2026-08-04 from the pinned npm package metadata in
`dependency-lock.json`. These are package-level unpacked upper bounds, not a
claim about the optimized Vite bundle or final installer.

| Package group | Raw unpacked upper bound |
| --- | ---: |
| PR #31 production packages before tree-shaking and compression | 87,805,423 bytes (83.74 MiB) |
| `playwright-core` optional Browser Agent feature pack | 12,701,224 bytes (12.11 MiB) |
| `@playwright/test` development-only wrapper | 28,544 bytes (0.03 MiB) |

The production raw total is dominated by tokenizer data and grammar WASMs.
VibeSpace imports only the reviewed OpenAI encodings, selected language
grammars, and lazy provider engines. Promptfoo and Playwright Test remain
outside the desktop dependency graph; browser binaries remain outside the
default installer.

Release gates:

1. Compare the optimized application bundle and installer against the same
   pre-PR baseline.
2. Record compressed deltas rather than presenting raw npm package size as
   installer growth.
3. Confirm lazy chunks do not load at startup unless their feature is used.
4. Confirm no Playwright browser binary is present in the default installer.
5. Keep the optional Browser Agent feature pack separately measurable and
   removable.

## Optimized production web bundle

The latest production build captured on 2026-08-04 contains 459 files totaling
62,177,226 bytes (59.30 MiB). It contains:

- zero JavaScript source maps;
- zero paths named for Playwright, Playwright browser assets, or Promptfoo;
- only the selected lazy tokenizer and Tree-sitter runtime assets used by the
  application.

Before production source maps were disabled, the captured build output contained
585 files totaling 98,510,525 bytes (93.95 MiB). Omitting release source maps
and the latest optimized build is 36,333,299 bytes (34.65 MiB) smaller.
Source maps remain available for an explicitly requested diagnostics build via
`VIBESPACE_BUILD_SOURCEMAPS=1`.

## Native installer verification

The native Tauri release build and both Windows bundle formats completed on
2026-08-04 after the web and TypeScript build passed. A short temporary drive
alias to the same trusted C: worktree avoided Windows' generated-path length
limit without copying or changing source:

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `VibeSpace_1.5.0_x64_en-US.msi` | 81,235,968 bytes (77.47 MiB) | `C212C102564E1123D90BC91A8DB876DF9A9C56C4A20143689E90DD2A3C6A61BF` |
| `VibeSpace_1.5.0_x64-setup.exe` | 68,007,104 bytes (64.86 MiB) | `9058FCA8B7CFD5014E56C2F6441A49E4F73ABF733DA831CC73F68520F4FDC277` |
| `jarvis.exe` | 90,546,176 bytes (86.35 MiB) | `96505E47DE50DB4556256286C5216F8ADAE4E8A47437CE4F167E15F26320B1DA` |

The MSI file table contains 22 payload rows totaling 112.97 MiB uncompressed.
No Playwright browser engine, Chromium, Firefox, WebKit, `ms-playwright`, or
Promptfoo runtime is present. The only matching payload rows are the required
`Apache-2.0-playwright.txt`, `NOTICE-playwright.txt`, and
`MIT-promptfoo.txt` legal notices.

Compilation and MSI/NSIS bundling succeeded. The final updater-signature step
was not performed because the session intentionally has no
`TAURI_SIGNING_PRIVATE_KEY`; no credential was requested or exposed. Release
signing therefore remains a controlled release-environment step rather than a
local implementation failure.

Earlier attempts established two environmental constraints without weakening
security: the original C: build initially exhausted free space, and Windows
Application Control correctly rejected Cargo build scripts executed from D:.
An obsolete generated target cache was moved to a recoverable archive, LLVM
and the Visual Studio bundled CMake were used from trusted locations, and no
user or product source was deleted.
