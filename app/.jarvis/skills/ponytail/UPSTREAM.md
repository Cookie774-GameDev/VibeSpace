# Ponytail source provenance

Repository: https://github.com/DietrichGebert/ponytail
Pinned commit: `356918eba965ee1eac64bd3a7f0dd02108350de5`
License: MIT, Copyright (c) 2026 DietrichGebert. See `LICENSE.txt`.

`SKILL.md` is copied from upstream `skills/ponytail/SKILL.md` without text changes.
VibeSpace's `src/lib/ai/ponytailInstructions.ts` adapts the pure
`filterSkillBodyForMode` logic from upstream `hooks/ponytail-instructions.js`:
remove frontmatter and inactive intensity rows/examples, selecting `full`.
It adds one VibeSpace activation boundary so per-chat `/mode` remains authoritative.
The final instruction text is compiled into both CLI provider paths each turn.

No upstream installer, global configuration, statusline, persistent flag files,
telemetry, MCP server, filesystem hook or extra process is included. VibeSpace
already owns the lifecycle and selected mode. Normal and Final Boss do not inject
these rules. The full upstream skill is discoverable in the built-in skill library.

Ponytail encourages less unnecessary implementation and prose; it does not
compress existing token sequences or guarantee savings for every model or task.
Its instruction tokens are overhead. Provider input, output, reasoning and cache
usage must be measured separately in comparable fresh sessions to establish a
VibeSpace result. Upstream benchmark percentages are not VibeSpace measurements.
