# VibeSpace — Jarvis Voice Module Reference-Clone Master Prompt

## Mission

You are the implementation agent responsible for rebuilding and polishing **only the VibeSpace Jarvis Voice Module** so that its visible UI matches the supplied reference image as closely as technically possible while preserving VibeSpace's existing architecture and all unrelated product behavior.

This is not a concept exercise, mockup, or design-only task. Implement the real production UI and connect every visual reaction to the real voice pipeline. The finished module must be refined, responsive, accessible, performant, and production-ready.

## Repository Target

- Repository: `Cookie774-GameDev/VibeSpace`
- Pull request: `#31`
- Target working branch: `agent/pr30-fixes-and-updates`
- Scope: Jarvis Voice Module only
- Existing geometry contract: repository-root `SCALE.md`

Do not modify unrelated VibeSpace pages, global density, global typography, navigation, settings surfaces, terminal UI, browser chat, benchmark UI, website UI, or any other module merely to make the Jarvis Voice Module easier to style.

## Execution Contract

Work autonomously from inspection through implementation and verification. Do not stop at a plan. Do not leave TODOs, placeholder meters, fake waveform values, random audio animations, disconnected controls, or partially wired states.

Use this loop until the Jarvis Voice Module is actually complete:

```text
INSPECT CURRENT IMPLEMENTATION
→ MAP REFERENCE IMAGE
→ TRACE REAL VOICE/TTS/MIC DATA FLOW
→ DEFINE STATE MACHINE
→ IMPLEMENT VISUAL CLONE
→ CONNECT REAL AUDIO REACTIVITY
→ TEST INTERACTIONS + AUDIO STATES
→ VISUAL-COMPARE AGAINST REFERENCE
→ FIX MISMATCHES
→ RUN TYPE/LINT/TEST/BUILD CHECKS
→ SELF-GRADE
→ FIX ANY FAILURE
→ DOCUMENT THE RESULT
```

If repository architecture differs from assumptions in this prompt, adapt to the real architecture rather than forcing an unnecessary rewrite.

---

# 1. Source-of-Truth Priority

When requirements appear to conflict, use this order:

1. The current user's explicit instruction.
2. The supplied Jarvis Voice reference image for visual appearance, visual hierarchy, color, effects, spacing, control placement, and overall composition.
3. `SCALE.md` for Jarvis-specific outer geometry, anchoring, scale, density, and responsive behavior.
4. Existing VibeSpace voice architecture and shared primitives for implementation details.
5. This prompt for behavior, testing, quality, and integration requirements.

Do not reinterpret the reference into a merely "similar" interface. Treat it as a visual target.

---

# 2. Scope Lock

## In scope

- Jarvis Voice panel/container.
- Jarvis orb/avatar and its speech-reactive animation.
- Jarvis title, status, transcript, labels, and supporting microcopy already represented by the module/reference.
- Microphone/listening controls.
- User microphone loudness visualization.
- Assistant-speaking visual feedback.
- Composer/input/action controls that belong inside the Jarvis Voice Module.
- Expand/collapse behavior if already part of the module/reference.
- Hover, pressed, focus, disabled, muted, listening, thinking, speaking, interruption, and error states.
- Responsive behavior of the Jarvis Voice Module.
- Voice-specific accessibility and reduced-motion behavior.
- Tests needed to prove these behaviors.

## Explicitly out of scope

- Global app scaling.
- Global `transform: scale(...)` tricks.
- Global font-size changes.
- Global theme/color changes.
- Sidebar/header/window chrome redesigns.
- Broad component-library rewrites unless a tiny, non-breaking shared fix is absolutely necessary.
- Voice-provider replacement unless the existing voice pipeline cannot expose the audio data required and a narrow adapter is needed.
- Unrelated refactors.

Any shared-file edit must be minimal, backward-compatible, and justified by the Jarvis Voice integration.

---

# 3. First: Inspect Before Editing

Before modifying code, identify the real files and execution path for:

- Jarvis Voice root component.
- `#jarvis-panel` and/or `.jarvis-glass-panel` if present.
- Jarvis Voice styles/tokens.
- The actual microphone capture source.
- The actual TTS/Jarvis audio playback source.
- Voice session state.
- Interrupt/barge-in handling.
- Mute/unmute behavior.
- Transcript and status updates.
- Audio cleanup on close/unmount.
- Existing test infrastructure.

Search by component names, visible copy, CSS selectors, TTS functions, `getUserMedia`, `MediaStream`, `AudioContext`, `AnalyserNode`, `HTMLAudioElement`, and voice-state enums.

Do not create a second parallel voice stack if the real stack already exists. Attach visualization to the existing sources.

---

# 4. Reference-Clone Requirement

Rebuild the module as a one-to-one visual reconstruction of the supplied reference at the canonical reference viewport, then make it responsive without destroying its composition.

Match, as applicable:

- Outer panel dimensions and placement.
- Border radius.
- Glass/translucency treatment.
- Border strength.
- Shadow depth and softness.
- Background layers.
- Highlights and subtle inner strokes.
- Orb size and alignment.
- Text hierarchy.
- Exact apparent font weight and line height.
- Status placement.
- Waveform/loudness placement.
- Mic and close controls.
- Separators.
- Composer/input geometry.
- Icon scale and optical centering.
- Control hit areas.
- Hover/focus/pressed visual behavior.
- Expanded and collapsed composition if the reference contains both.

Do not substitute arbitrary neon gradients, excessive bloom, or generic sci-fi visuals that are not present in the reference.

Use the reference image to sample/derive visual tokens rather than guessing colors from memory.

---

# 5. Existing Scale Contract — Preserve It

Treat the repository-root `SCALE.md` as an immutable geometry/anchoring contract unless the current reference image demonstrably supersedes a value.

Important anchors from that contract include approximately:

- Jarvis-only selector scope: `#jarvis-panel` and/or `.jarvis-glass-panel`.
- Horizontal reference unit: `1H = reference panel width / 12`.
- Vertical reference unit: `1V ≈ 21.50 px`.
- Panel horizontal padding: approximately `22.7 px` / `1H`.
- Panel vertical padding: approximately `20.5 px` / `1V`.
- Orb/avatar: approximately `80 px` / `3.72V` where that scale variant applies.
- Headline: approximately `38.2 px` / `1.78V`.
- Status: approximately `11.9 px` / `0.55V`.
- Transcript: approximately `12.7 px` / `0.59V`.
- Panel radius: approximately `32.2 px` / `1.50V`.
- Composer min-height: approximately `44.9 px` / `2.09V`.
- Composer radius: approximately `22.4 px` / `1.04V`.
- Send button: approximately `33.4 px` / `1.55V`.
- Desktop positioning: vertically centered around `top: 50vh` with `translateY(-50%)` behavior where the current contract uses it.

If `SCALE.md` contains newer values than those quoted here, the file itself wins.

Never scale the whole app or whole modal with a transform to force a screenshot match.

---

# 6. Voice UI State Machine

Use or map the existing app state into an explicit presentation state equivalent to:

```ts
type VoiceUiState =
  | 'idle'
  | 'listening'
  | 'user_speaking'
  | 'thinking'
  | 'jarvis_speaking'
  | 'interrupted'
  | 'error';
```

Do not duplicate business state unnecessarily. This presentation state may be derived from existing voice/TTS/session flags.

## Required semantics

### `idle`

- Jarvis orb is visually alive only through static rendering, not animated speech motion.
- User mic meter is at zero unless the product intentionally keeps a live listening stream open.
- No fake bouncing bars.

### `listening`

- Orb remains static because Jarvis is not speaking.
- Mic loudness display is driven from the real microphone input.
- Near-silence produces near-zero movement.

### `user_speaking`

- Orb remains static.
- Mic meter follows real user loudness closely.
- Louder speech must visibly create a stronger response than quiet speech.

### `thinking`

- Orb must not perform the speech animation.
- A non-speech status transition may be shown only if the reference/current product defines it.
- Do not repurpose speech motion as a generic loading animation.

### `jarvis_speaking`

- Orb becomes dynamically audio-reactive.
- Motion intensity comes from **actual Jarvis/TTS output energy**, not a timer or random function.
- If the user mic meter is intended to represent the user's microphone, it must remain a user-mic visualization rather than becoming a Jarvis-output meter.

### `interrupted`

- Jarvis output energy falls to zero as playback is stopped/ducked.
- Orb settles immediately and smoothly.
- User-mic behavior reflects the actual barge-in state.

### `error`

- Audio-reactive motion stops.
- Provide the existing/reference-consistent error state without loud or distracting looping animation.

---

# 7. Non-Negotiable Orb Behavior

The left Jarvis orb must move **only when Jarvis is audibly speaking**.

This means:

- No idle breathing loop.
- No perpetual pulsing.
- No random noise deformation while idle.
- No thinking-state speech animation.
- No movement merely because a boolean says a request is pending.
- No simulated waveform based on elapsed time.

## Correct signal source

Prefer, in order:

1. Existing decoded PCM/audio-energy events from the TTS pipeline.
2. Existing Web Audio node in the real playback graph.
3. A single `AnalyserNode` attached safely to the real TTS playback source.
4. A compatible worklet/stream analyser when required by the current playback architecture.

Derive a normalized assistant-output energy value `E` in `[0, 1]` from the real signal.

Example conceptual math:

```text
rms = sqrt(mean(sample^2))
energy = clamp((rms - noiseFloor) / (speechCeiling - noiseFloor), 0, 1)
smoothed = attackReleaseFilter(energy)
```

Use perceptual shaping if needed:

```text
visualEnergy = pow(smoothed, 0.65 .. 0.85)
```

The exact coefficients should be tuned against the reference and actual voice output.

## Orb visual mapping

The real output energy may subtly drive:

- Outer scale.
- Inner core scale.
- Halo/glow opacity.
- Glow radius.
- Ring displacement.
- Surface distortion/deformation.
- Particle displacement if particles are actually part of the reference.

Example restrained calibration range:

```text
scale         = 1.00 + 0.03..0.06 * E
glowOpacity   = base + 0.10..0.25 * E
glowRadius    = base + smallDelta * E
surfaceAmount = tunedCurve(E)
```

Do not over-animate. The result should look like a premium speaking visualization, not a music visualizer.

At actual digital silence or when playback stops, all speech-reactive values must settle toward their neutral values.

---

# 8. Real User Microphone Loudness Meter

The microphone loudness visualization must represent how loudly the **user is actually speaking**.

Do not use random bar heights, canned keyframes, or a fake sine wave.

## Signal path

Use the real microphone `MediaStream` already owned by the voice session when possible. Only call `getUserMedia` separately if there is genuinely no shared stream API and doing so will not create duplicate permission prompts or competing capture tracks.

Preferred Web Audio path:

```text
MediaStream
→ MediaStreamAudioSourceNode
→ AnalyserNode
→ time-domain + optional frequency-domain samples
→ RMS / peak / spectrum bands
→ noise gate
→ normalization
→ attack/release smoothing
→ visual meter
```

## Truthful response

- Whisper/very quiet input → low response.
- Normal speech → medium response.
- Loud speech → visibly stronger response.
- Silence → settles low/zero.
- Muted mic → zero/static.
- Ended stream → zero/static.
- Permission denied → zero/static plus product-consistent error/permission state.

## Noise gating

Use a calibrated or adaptive noise floor. A typical initial RMS gate may be around `0.015–0.03`, but tune to the real environment and existing audio processing rather than hardcoding blindly.

Conceptually:

```text
level = clamp((rms - gate) / (ceiling - gate), 0, 1)
```

Apply fast-enough attack and slower release so the meter feels responsive but not jittery.

## Multi-bar waveform

If the reference uses multiple vertical bars, derive them from real data. Good options include:

- Real frequency bands from the FFT.
- Deterministic weighted slices of real spectrum data.
- RMS + peak-derived neighboring bar shaping.

Never inject random bar values merely to make the waveform look busy.

---

# 9. Echo / Barge-In Correctness

The user's mic meter must not falsely spike simply because Jarvis audio is playing through the speakers.

Use the existing voice stack's echo cancellation, noise suppression, ducking, or barge-in strategy where available.

If barge-in is supported:

- Keep capturing real mic input.
- Preserve browser/system acoustic echo cancellation where supported.
- The user meter remains mic-derived.
- Interruption should stop/duck TTS and transition states correctly.

If barge-in is intentionally disabled during playback:

- Pause or visually zero the user meter during assistant playback according to the real capture state.
- Do not display TTS energy as if it were user loudness.

---

# 10. Audio Lifecycle and Resource Safety

Production correctness is mandatory.

- Reuse an existing `AudioContext` when architecture permits.
- Do not create an `AudioContext` on every render.
- Do not create multiple `MediaElementAudioSourceNode`s for the same media element.
- Create at most one visualization animation loop per active module.
- Cancel `requestAnimationFrame` on teardown.
- Disconnect analyser/source nodes on teardown.
- Remove event listeners on teardown.
- Stop microphone tracks only if this component owns them.
- If a higher-level voice session owns the stream, never terminate it accidentally.
- Handle `AudioContext` suspended/resumed states.
- Handle device changes and ended tracks.
- Handle close/reopen without accumulating audio nodes.
- Handle repeated TTS messages without leaking source nodes.
- Handle rapid interrupt/restart sequences.

---

# 11. React / UI Architecture Guidance

Use the repository's actual framework and conventions. If the module is React-based, prefer a structure such as:

```ts
type AudioLevel = {
  rms: number;
  peak: number;
  normalized: number;
  active: boolean;
};

useMicLevel(existingMicStream)
useJarvisOutputLevel(existingPlaybackSource)
```

For high-frequency animation data:

- Keep raw analyser values in refs or an external animation controller.
- Avoid causing the entire React component tree to rerender at 60 FPS.
- Use CSS custom properties, direct element refs, canvas drawing, or a narrowly scoped animation layer.
- Keep React state for coarse UI states, not every audio sample.

Example CSS-variable bridge:

```ts
orbEl.style.setProperty('--jarvis-energy', visualEnergy.toFixed(4));
meterEl.style.setProperty('--mic-level', micLevel.toFixed(4));
```

The exact implementation should match the codebase's standards.

---

# 12. Animation Quality

There are two different motion categories and they must remain distinct.

## Signal-reactive motion

Driven by real audio data:

- Orb speech movement.
- Mic loudness visualization.

Do not implement these as independent infinite CSS keyframes.

## Interface transition motion

May use CSS/animation-library easing:

- Open/close.
- Expand/collapse.
- Hover.
- Press.
- Focus indication.
- Status crossfade.
- Control enable/disable transitions.

Use restrained premium easing and avoid bouncy novelty motion unless the reference clearly shows it.

---

# 13. Reduced Motion

Honor `prefers-reduced-motion` without destroying the information conveyed by voice activity.

In reduced-motion mode:

- Remove or drastically reduce spatial deformation/pulsing.
- Keep a low-amplitude, non-disorienting visual energy indication when Jarvis is speaking.
- Keep the user loudness meter functional because it communicates audio input status.
- Avoid rapid scale changes and large blur/glow expansion.
- Keep open/close transitions short or immediate.

---

# 14. Accessibility

- Every icon-only control needs an accessible name.
- Mic toggle must expose current pressed/muted state.
- Close/collapse controls must be keyboard reachable.
- Focus indication must be visible and reference-compatible.
- Status changes should use an appropriate live region only when it improves usability and will not spam screen readers.
- Preserve logical tab order.
- Do not use color alone to communicate muted/error/listening state.
- Maintain sufficient contrast for functional text and controls.
- Minimum target sizes should remain usable even if the visual icon is smaller.

---

# 15. Responsive Behavior

Preserve the cinematic reference proportions on desktop and degrade gracefully on narrower windows.

- Use scoped responsive variables/clamps inside the Jarvis module.
- Reduce gaps before making text microscopic.
- Preserve orb, identity, status, mic control, close control, and core voice feedback.
- Prevent horizontal clipping.
- Keep expanded content scrollable if needed.
- Do not modify application-wide zoom or density.
- Do not use `transform: scale()` on the entire modal to fit small viewports.

`SCALE.md` remains the authority for existing responsive anchors.

---

# 16. Visual Fidelity Process

At the canonical reference resolution:

1. Capture the real implementation.
2. Overlay/diff it against the reference image.
3. Correct macro geometry first.
4. Correct internal spacing/alignment second.
5. Correct typography third.
6. Correct color/glass/border/shadow/glow fourth.
7. Correct micro-details/icons fifth.
8. Correct motion behavior last.
9. Repeat until remaining differences are intentional or technically unavoidable.

Do not compensate for one wrong dimension by shifting unrelated elements.

---

# 17. Performance Requirements

- Target smooth animation at the app's normal frame rate.
- One scoped render/analysis loop rather than one loop per bar.
- No forced synchronous layout in the animation loop.
- Prefer transforms/opacity for cheap motion.
- Use filters/blurs carefully; large animated blur radii can be expensive.
- If using canvas/WebGL, cap effective DPR if required for GPU stability while preserving reference quality.
- Pause expensive visualization work when the module is hidden or inactive.
- Avoid memory growth across repeated open/close cycles.

---

# 18. Failure and Edge Cases

Verify all of these:

- Microphone permission denied.
- No microphone device.
- Mic device disconnected.
- Mic muted before opening.
- TTS begins before analyser initialization finishes.
- TTS ends naturally.
- TTS is cancelled.
- User interrupts Jarvis.
- Jarvis immediately speaks again.
- Voice panel closes during playback.
- Voice panel closes during mic capture.
- Voice panel reopens repeatedly.
- AudioContext begins suspended.
- App loses/regains focus.
- Long transcript text.
- Long status/model labels.
- Narrow desktop window.
- Reduced-motion preference.

The UI must fail gracefully without runaway animation or stale meters.

---

# 19. Testing Requirements

Use the repository's real commands from `package.json` and project documentation. Run the applicable checks rather than assuming command names.

At minimum verify:

- Type checking.
- Linting.
- Unit/component tests relevant to the changed code.
- Production build.
- Jarvis Voice module opens/closes correctly.
- Mic meter reacts to real quiet vs normal vs loud microphone input.
- Mic meter drops to zero when muted/ended.
- Orb stays static when idle/listening/thinking.
- Orb responds only during real assistant audio playback.
- Orb response becomes stronger on higher assistant-output amplitude.
- Orb stops on playback end/cancel/interruption.
- No duplicated audio nodes after reopen.
- No console errors.
- No regressions outside Jarvis Voice.

Where practical, add deterministic tests around the signal-processing functions by feeding known sample arrays and verifying output level/smoothing behavior.

---

# 20. Visual Acceptance Criteria

The implementation is accepted only if:

- The supplied reference image is immediately recognizable as the same interface when compared to the real module.
- Outer panel position and dimensions follow the established scale contract.
- Orb placement/size match the reference.
- Typography hierarchy matches the reference.
- Controls are aligned and optically centered.
- Glass/border/shadow/glow treatment matches the reference rather than a generic interpretation.
- Expanded/collapsed states, if present, preserve reference proportions.
- No unrelated VibeSpace UI changes are visible.

---

# 21. Functional Acceptance Criteria

The implementation is accepted only if:

- Jarvis speech is functional.
- Microphone input is functional.
- Orb motion is derived from real Jarvis output energy.
- Orb does not perform speech motion while Jarvis is silent.
- User loudness meter is derived from real microphone energy.
- Quiet input is visibly lower than loud input.
- Muted/no-stream input produces zero/static meter behavior.
- User meter is not intentionally faked from TTS output.
- Voice interruption does not leave stale animation running.
- Audio resources are cleaned up correctly.
- Reopening the module does not degrade behavior.

---

# 22. Prohibited Shortcuts

Do not ship any of the following:

- `Math.random()` meter animation.
- Random CSS waveform bars.
- Infinite orb pulse presented as speech activity.
- Hardcoded fake audio levels.
- A timer-based speech visualizer.
- A static screenshot/image replacing the real UI.
- Global application scaling.
- Huge unrelated refactors.
- Placeholder controls.
- Controls that look functional but are not connected.
- Comments saying "wire this later".
- Skipping build/test because the UI looks correct.

---

# 23. Self-Grade Before Completion

Grade the final implementation from 0–100 in each category:

```text
Reference fidelity             /100
Jarvis orb signal accuracy     /100
Mic meter signal accuracy      /100
Voice-state correctness        /100
Animation polish               /100
Responsive behavior            /100
Accessibility                  /100
Performance/resource cleanup   /100
Regression safety              /100
Production readiness           /100
```

Any category below 95/100 requires another repair pass unless there is a concrete external limitation outside the repository. For any unavoidable limitation, document exactly what prevents a perfect result and what the safest fallback is.

---

# 24. Final Implementation Report

When finished, provide a concise engineering report containing:

- Files changed.
- What was rebuilt visually.
- How the real mic level is measured.
- How the real Jarvis/TTS level is measured.
- How the orb is guaranteed to stay static when Jarvis is silent.
- How echo/barge-in behavior is handled.
- Tests/checks run and their results.
- Reference-comparison result.
- Any narrowly scoped limitation that remains.

Do not describe unfinished work as complete.

---

# 25. Final Directive

Build the reference-cloned Jarvis Voice Module in the actual VibeSpace codebase. Preserve everything outside the Jarvis Voice scope. Make every visible audio reaction truthful to the real microphone or real assistant output. Refine the module until it looks intentional, premium, coherent, and production-ready—not approximate, simulated, or half-connected.
