# Ponytail source provenance

Repository: https://github.com/DietrichGebert/ponytail
Pinned release: `v4.10.0`
Pinned commit: `1d95ff7d39de12d87014ea40d4e22201bddc501b`
License: MIT, Copyright (c) 2026 DietrichGebert. See `LICENSE.txt`.

`SKILL.md` and `LICENSE.txt` are copied from upstream `v4.10.0`.
VibeSpace's `src/lib/ai/ponytailInstructions.ts` adapts the pure
`filterSkillBodyForMode` logic from upstream
`hooks/ponytail-instructions.js` at the pinned commit: it removes frontmatter
and inactive intensity rows/examples, selecting `full`. It adds one VibeSpace
activation boundary so per-chat `/mode` remains authoritative. The final
instruction text is compiled into both CLI provider paths each turn.

No upstream installer, global configuration, statusline, persistent flag files,
telemetry, MCP server, filesystem hook or extra process is included. VibeSpace
already owns the lifecycle and selected mode. Normal and Final Boss do not inject
these rules. The full upstream skill is discoverable in the built-in skill library.

Ponytail changes agent implementation behavior and prose; it does not compress
existing token sequences or guarantee savings for every model or task. Its
instruction tokens are overhead. The VibeSpace execution path keeps admitted
context intact and records zero optimizer trimming; provider input, output,
reasoning and cache usage must be measured separately in comparable fresh
sessions to establish a VibeSpace result. Upstream benchmark percentages are
not VibeSpace measurements.
