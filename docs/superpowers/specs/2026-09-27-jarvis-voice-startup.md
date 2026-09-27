# Jarvis voice startup and compact input

## Goal

Opening Jarvis shows a usable panel immediately. The selected STT engine starts independently of chat loading; a recognized turn reaches the existing voice coordinator and speaks acknowledgment and result through the selected voice. A saved setting resumes the provider's last Jarvis chat by default; the other setting creates a new chat on each opening. An optional translucent mini bar submits typed turns through the same coordinator and receives spoken replies.

## Boundaries

- Keep the current STT, TTS, chat routing, and one-worker coordinator. Do not add another voice path.
- Never show listening until the STT engine opens; a network or microphone failure reports its real state and keeps typed input usable.
- Preserve provider-specific chat affinity, worker continuity, dedupe, and existing voice-only prompt rules.
- Persist both settings independently, defaulting to resume and mini bar off.

## Checks

Focused startup, setting persistence, STT failure, and typed-turn tests; TypeScript and native Instance 2 Playwright for opening time, STT, typed send, saved mode, and spoken result. Report any real mic or provider limitation precisely.
