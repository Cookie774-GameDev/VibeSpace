# PR #31 Third-Party Notices

This directory inventories third-party code and runtime assets newly adopted,
copied, or distributed by the VibeSpace PR #31 intelligence and browser
upgrade. It does not replace notices for dependencies that predate this
program.

The exact releases, repository commits, package integrity hashes, and purposes
for newly pinned runtime packages are recorded in `dependency-lock.json`.
Current additions are:

- `gpt-tokenizer` 3.4.0 (MIT);
- `@huggingface/tokenizers` 0.1.3 (Apache-2.0);
- `web-tree-sitter` 0.26.11 (MIT);
- `@repomix/tree-sitter-wasms` 0.1.17 (Unlicense);
- `tree-sitter-json` 0.24.8 (MIT);
- `@opentelemetry/api` 1.9.1 (Apache-2.0);
- `@opentelemetry/sdk-trace-base` 2.10.0 (Apache-2.0);
- `@modelcontextprotocol/sdk` 1.30.0 (MIT), used only behind the
  VibeSpace-owned gateway, trust, approval, and scope boundaries;
- `playwright-core` 1.61.1 (Apache-2.0), used by development fixtures and the
  separately packaged optional Browser Agent feature pack; browser binaries
  are not downloaded into the default application;
- `@playwright/test` 1.61.1 (Apache-2.0), development-only browser verification;
- `promptfoo` 0.121.20 (MIT), invoked only as pinned development/CI
  tooling and excluded from the desktop application dependency graph and
  installer.
- `espeak-rs-sys` 0.2.0, vendored from crates.io checksum
  `2d45d148019084e930df6cc3964a58c4c211342451ec5d3c328d8a6cc6b3464d`
  and piper-rs commit `d70b0970a87453f3476b5fd6cf9edf329be8b445`.
  Its Rust wrapper metadata declares MIT, but the crate archive contains no
  standalone authoritative MIT notice. VibeSpace removes only the Windows
  debug-only `msvcrtd` link block from `build.rs`.
- The crate embeds eSpeak NG 1.52.0.1 source under
  `app/src-tauri/vendor/espeak-rs-sys-0.2.0/espeak-ng/`. Those sources state
  GPL-3.0-or-later and are statically linked by the native build. Source
  vendoring and local non-distributed QA builds are approved; production
  object-code distribution is blocked pending the licensing-owner decision
  described in `ESPEAK_RS_SYS_VENDOR_DECISION.md`.

The corresponding distributable license texts and the applicable Playwright
NOTICE are preserved under `licenses/`; `licenses/README.md` maps every entry
to its text and notice. The distribution packaging step must include that
directory without rewriting it. Add another entry only after:

1. the exact upstream release or commit is pinned;
2. its license and applicable NOTICE material are verified;
3. copied or modified files are recorded;
4. production versus development-only packaging is confirmed;
5. installer and runtime impact is measured.

Selected candidates in the architecture decision that are not listed in
`dependency-lock.json` remain evaluations and must not be represented as
shipped dependencies.

The vendored Rust/native source above is intentionally not added to
`dependency-lock.json`, whose schema models npm package-lock integrity. Its
provenance, modification, license status, and release blocker are recorded in
`copied-code-inventory.md`, `sbom-pr31.cdx.json`, and
`ESPEAK_RS_SYS_VENDOR_DECISION.md`.

## Ponytail (Token Saver)

DietrichGebert/ponytail, pinned commit 356918eba965ee1eac64bd3a7f0dd02108350de5, MIT, Copyright (c) 2026 DietrichGebert. The upstream skill and adapted full-mode filtering are bundled for Token Saver. Full license and modification record: app/.jarvis/skills/ponytail/LICENSE.txt and UPSTREAM.md. No lifecycle executables or global hooks are installed.
