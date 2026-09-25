# X26 learnings (2026-09-25)

## Local dictation source files

The Systran faster-whisper model provides `vocabulary.txt`; requesting `vocabulary.json` directly made the free local download fail near completion. When an older native runtime expects JSON, download the real text vocabulary and convert it into a bounded JSON token array before the installed check. Verify with native transcription, not just a download status.

## OpenCode peer relay

The stored PTY transcript is a stream of full-screen redraws. Its last characters can be spinner and box glyphs rather than the agent's response. Relay a detected completed reply or user-entered message. Never forward a raw transcript tail as an agent message. Test with two native OpenCode terminals and inspect the recipient's prompt and generated answer.

## Native test startup

OpenCode in the busy VibeSpace repository can spend minutes creating snapshots before a short prompt runs. Keep the model and OAuth route verified separately, then allow the native TUI session to finish; do not treat startup latency as a provider failure without its log evidence.
