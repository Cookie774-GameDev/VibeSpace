# Ponytail source provenance

Repository: https://github.com/DietrichGebert/ponytail
Pinned release: `v4.10.0`
Pinned commit: `1d95ff7d39de12d87014ea40d4e22201bddc501b`
License: MIT, Copyright (c) 2026 DietrichGebert. See `LICENSE.txt`.

`SKILL.md`, `LICENSE.txt`, and the separate `../ponytail-audit/SKILL.md` are
copied unchanged from that upstream commit. The Ponytail instruction artifact
`full-instructions.md` is the exact output of the original
`hooks/ponytail-instructions.js` builder called as
`getPonytailInstructions('full')`; its SHA-256 is
`da4fb09cff2f6726691ce6591cebc38c95597d79da132e49c6fa2665c4e8a3ff`.
VibeSpace imports that generated artifact and appends its own `/mode`
activation boundary. It does not duplicate the upstream mode-filtering logic.

The audit skill is a separate built-in skill selected explicitly through the
skill UI. It has no automatic trigger and is not injected on Token Saver turns.
Its upstream instructions produce a one-shot report and apply no fixes.

No upstream installer, global configuration, statusline, persistent flag files,
telemetry, MCP server, filesystem hook, or extra process is included. Normal and
Final Boss do not inject Ponytail instructions.

Ponytail changes agent implementation behavior and prose; it does not compress
existing token sequences or guarantee savings for every model or task. Its
instruction tokens are overhead. The VibeSpace execution path keeps admitted
context intact and records zero optimizer trimming; provider input, output,
reasoning and cache usage must be measured separately in comparable fresh
sessions to establish a VibeSpace result. No VibeSpace savings claim is made.
