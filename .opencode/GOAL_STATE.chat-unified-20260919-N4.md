# Goal State — star-catcher game verification (task chat-unified-20260919-N4)

## Goal
Verify the existing star-catcher game at
`work/chat-unified-20260919-N4/native/game`, read its source, run the supplied
verifier, and report the exact command and result. Do not edit the game source.

## Status: COMPLETE

## What was read
- `work/chat-unified-20260919-N4/native/game/index.html` (155 lines; only file in `game/`).
  Canvas-based game: player paddle, falling gold stars (+10) and red blocks (game over),
  arrow-key movement, R/restart button, aria-live score, accessible canvas label.
- `work/chat-unified-20260919-N4/root/verify-game.mjs` (58 lines). Loads the game
  `<script>` into a `node:vm` context with stub DOM, installs a test seam, asserts
  11 behaviors, writes `root/game-verification.json`.

## Verification command (exact)
From `C:\Users\viper\VibeSpace-UnifiedChungus-Final`:

    node work/chat-unified-20260919-N4/root/verify-game.mjs

## Result
- Exit code: 0
- Output:
  `{"checks":11,"passed":true,"sha256":"1039396db051d1ad9deb9776ca1196e60c1ab3ebd6b8c86e0f9dcaf12bebdf82","type":"independent game logic check; not native UI evidence"}`
- 11/11 checks passed.
- Source SHA-256 independently recomputed with Node = `1039396db051d1ad9deb9776ca1196e60c1ab3ebd6b8c86e0f9dcaf12bebdf82` (matches evidence).
- Evidence file written by the verifier: `work/chat-unified-20260919-N4/root/game-verification.json`.

## Files changed by this task
- `.opencode/GOAL_STATE.chat-unified-20260919-N4.md` (this checkpoint).
- `work/chat-unified-20260919-N4/root/game-verification.json` (produced by the verifier itself).
- No game source edited.

## Notes / risks
- The verifier explicitly labels itself "not native UI evidence". It is a logic/regression
  check only; it does not exercise the real rendered canvas in a browser/Tauri WebView.
- If native UI evidence is required, that is a separate authorized step.

## Resume command
    node work/chat-unified-20260919-N4/root/verify-game.mjs
(run from `C:\Users\viper\VibeSpace-UnifiedChungus-Final`)
