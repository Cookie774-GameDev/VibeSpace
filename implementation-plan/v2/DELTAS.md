# V2 Plan — Deltas from latest user message

> Captures four explicit user asks added after plans A/B1/B2/C/D/E were written. Each is folded into the matching plan; this file is a checklist, not a re-plan.

## 1. "Pulsating background when inactive, cool wake animation"

Already covered: **plan-E §3.4** specifies the AmbientOrb breathing scale 0.95→1.05 over 4s with halo opacity oscillation, **§5.1 entrance** (1200ms ease-out crossfade), **§5.3 wake transition** (1.02 scale + 400ms fade-in restoring AppShell). 

Reinforce in implementation: the **whole ambient surface** has a global "pulse" rhythm at 4s — orb, drift particles, and the ambient-deep ground radial vignette all share the same timing function so the entire screen breathes together. Wake on input animates from that shared phase, so it never feels like animations are mid-cycle. Add a `--ambient-phase` CSS variable updated by a single RAF loop in `AmbientHome.tsx` so card pulse + orb + vignette all read the same clock.

**No spec change**. Implementation note added in §5 of plan-E during E7.

## 2. "Speech-to-text option, make it accessible"

Already covered: V1 ships Web Speech recognition (`voice/VoiceService.ts`). Plan A §9.5 lists per-engine configuration. Plan E §7.1 keeps wake-word listening in idle mode.

Reinforce: STT is **already on** in V1. The accessibility story is twofold:
- **Settings → Voice → Always-listening (passive STT)**: when on, hot-mic stays open and "Jarvis" anywhere wakes the modal. Defaults OFF (battery + privacy).
- **Settings → Accessibility → Voice-to-text in Composer**: a new toggle. When on, the chat composer gets a small mic button next to send; tap, speak, see live transcript fill the textarea, tap again to stop. Different from voice modal (which sends + speaks back); this is purely STT-into-text.
- Reduced-motion / screen-reader: voice-modal aria-live region announces transcript; no decorative animations gate the feature.

**Spec change**: plan-A §9.5 adds bullet "Voice-to-text in Composer" toggle. Implementation lands in **E6** alongside the orb/RMS work.

## 3. "Multiple terminals per project (each one Claude/OpenCode etc)"

Already covered: **plan-C §3.1 (Grid layout)** ships 1/2/3/4-pane grids per project. **§4** ships nine built-in presets including Claude, OpenCode, Bash, PowerShell, Cmd, Python, Node, Git status, npm-dev. **§5.1.4 terminal_layouts** persists per-project pane assignments so each project remembers which presets are open in which slot.

Reinforce: project switcher shows pane count badge ("4 terminals running") in TabStrip per Plan C §11.6. Closing the project window leaves PTYs running detached (in V2 they actually die at app quit, since tmux is opt-in only — this is acknowledged in plan-C §11.7). User toggle "Tmux session resume" surfaced in Settings → Terminals → Advanced.

**No spec change**. Just confirming.

## 4. "Full-screen terminal toggle"

**New ask**. Add to plan-C:

- New `view_mode` enum value `fullscreen` (existing values: `single | grid | tabs`).
- Hotkey: **`Mod+Shift+F`** while terminal canvas focused → toggles fullscreen on the active pane.
- Fullscreen layout: focused pane fills the entire workspace area below TopBar (NavPane and TodoPanel auto-collapse with smooth Motion `panelSlide` exit). Other panes are kept alive but hidden.
- Exit: same hotkey, or `Esc` while fullscreen, or click "Exit fullscreen" chip in the pane header.
- Persists in `terminal_layouts.view_mode` so the project remembers if it was last fullscreen.

**Spec change**: plan-C §3.1 adds `fullscreen` to view_mode union; §7.1 adds `TERMINAL_FULLSCREEN_TOGGLE: 'Mod+Shift+F'`. **No new files** beyond what plan-C already lists. Implementation lands in **E5**.

## 5. "More APIs"

Already covered: **plan-B2 §1** adds xAI, Ollama, OpenCode-local, OpenAI-compatible factory (covers OpenRouter, Together, Groq, Fireworks, Anyscale, Perplexity), Anthropic-compatible. Plan A §9.2 has the Settings UI for all of them.

Reinforce: confirm built-in pre-registrations for these openai-compatible instances ship disabled-with-empty-key so they show up in Settings on first launch. User adds key → instance flips enabled.

**No spec change**.

## 6. "Real install application, already installed on my computer"

This requires **E1** (Tauri installer build) to land. Until E1 ships:
- Dev path is `npm run tauri:dev` (already works on V1).
- Installed path arrives after E1 produces an MSI / NSIS installer per **plan-B1 §2.1**. After that bundle is built once locally, the user can run the .msi to install Jarvis as a real Windows app with a Start-menu entry.

**No spec change**. Sequencing: E1 must run, then `npm run tauri:build` produces `app/src-tauri/target/release/bundle/msi/Jarvis_0.2.0_x64_en-US.msi`. We install that on user's machine at the end of the wave.

---

## Updated wave checklist

| Wave | Adds (delta) |
|---|---|
| E0 | (no change) — foundation types/db |
| E1 | (no change) — Tauri/installer/security |
| E2 | (no change) — providers |
| E3 | (no change) — schedule |
| E4 | (no change) — launcher/media |
| E5 | **+ fullscreen view_mode + Mod+Shift+F hotkey** |
| E6 | **+ voice-to-text composer button**, **+ accessibility settings section pieces** |
| E7 | **+ shared --ambient-phase CSS variable for synchronized breathing** |
| E8 | (no change) — integrations |
| E9 | **+ Accessibility settings section** with Voice-to-text-in-Composer toggle |
| E10 | (no change) — polish |

End of deltas.
