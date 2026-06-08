# Jarvis One 0.1.25

## Highlights

- New optional **Jarvis Core** black/orange app theme based on the supplied references.
- Five persisted spoken voice profiles: Jarvis Prime, Aurora, Atlas, Nova, and Sentinel.
- Normal completed chat replies can speak aloud with the selected voice.
- Local Models can detect/start Ollama, download models in-app with live progress, and select completed pulls.
- Provider settings now show real locally recorded monthly usage instead of placeholder counters.

## Fixes

- System theme now follows the operating system preference.
- Slash command menus and option pickers now inherit app theme tokens.
- Release manifest generation skips unsigned platform archives when signed updater artifacts exist.

## Verification

- Targeted Vitest suite.
- Frontend TypeScript typecheck.
- Rust `cargo check`.
- Release manifest fixture test.
