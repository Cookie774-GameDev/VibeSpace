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
