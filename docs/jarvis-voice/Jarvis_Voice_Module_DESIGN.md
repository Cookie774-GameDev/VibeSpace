# VibeSpace — Jarvis Voice Module UI & Motion Design Contract

## Design Objective

This document defines the visual, interaction, audio-reactive, responsive, and accessibility contract for the **Jarvis Voice Module only**.

The finished module must feel like the supplied reference image brought to life inside the real VibeSpace product—not a loosely inspired redesign.

The interface should be cinematic and premium while remaining restrained, legible, fast, and functionally honest.

---

# 1. Scope Boundary

This design contract covers:

- Jarvis Voice container/panel.
- Orb/avatar.
- Jarvis identity/status text.
- Transcript/supporting text inside the voice module.
- User microphone loudness visualization.
- Voice controls.
- Composer/actions belonging to the voice module.
- Expanded/collapsed Jarvis presentation if present.
- Voice-specific motion.
- Responsive states.
- Accessibility behavior.

It does **not** authorize changes to:

- App-wide scale.
- App-wide typography.
- Main navigation.
- Sidebar.
- Terminal UI.
- Browser/chat surfaces.
- Benchmark/news surfaces.
- Website UI.
- Global theme tokens merely to force this module to match.

---

# 2. Source-of-Truth Precedence

Use this order:

1. Current explicit user direction.
2. Supplied reference image for visible appearance.
3. Repository `SCALE.md` for Jarvis-specific dimensions/anchoring.
4. Existing VibeSpace component conventions for implementation details.
5. This design contract for state behavior and quality constraints.

Where a color or detail is visible in the image, sample/match it rather than inventing a new value.

---

# 3. Visual Character

The module should read as a sophisticated voice control surface rather than a generic modal.

Reference-aligned qualities to preserve:

- Strong visual hierarchy.
- Dark/translucent premium surface treatment where shown.
- Controlled depth.
- High-quality rounded geometry.
- Crisp, optically centered controls.
- Deliberate separation between identity, voice feedback, and actions.
- Subtle, coherent glow rather than uncontrolled bloom.
- Motion that appears connected to speech and input rather than decorative.

Do not add effects solely because they look "sci-fi."

---

# 4. Component Anatomy

The implementation should preserve the reference's actual arrangement, but conceptually the module contains these zones:

```text
┌───────────────────────────────────────────────────────────┐
│  ORB   JARVIS / STATUS    VOICE FEEDBACK     MIC / CLOSE │
│                                                           │
│        TRANSCRIPT / CONTEXT / BODY AS REFERENCE REQUIRES │
│                                                           │
│        COMPOSER / ACTIONS AS REFERENCE REQUIRES          │
└───────────────────────────────────────────────────────────┘
```

Do not force this conceptual diagram if the image differs; the image wins.

---

# 5. Outer Panel Geometry

The panel should use the current `SCALE.md` as the geometry contract.

Current known anchors include approximately:

```text
Vertical reference unit: 1V ≈ 21.50 px
Horizontal reference unit: 1H = reference panel width / 12
Panel horizontal padding: ≈ 22.7 px / 1H
Panel vertical padding: ≈ 20.5 px / 1V
Panel radius: ≈ 32.2 px / 1.50V
```

Viewport placement follows Jarvis-specific anchoring defined in `SCALE.md`, including vertical centering behavior where currently specified.

## Rules

- No whole-app scaling.
- No whole-panel `transform: scale()` as a responsive strategy.
- No arbitrary width shrink that turns the cinematic module into a tiny utility card.
- Preserve the reference's perceived weight and breathing room.

---

# 6. Orb / Avatar Geometry

Known scale-contract anchor for the applicable state:

```text
Orb/avatar ≈ 80 px / 3.72V
```

If the supplied reference shows a larger state, use the exact reference/state-specific scale rules already defined by the current Jarvis contract.

## Placement

- Preserve reference left inset.
- Align optically with the Jarvis identity/status block.
- Do not allow speech expansion to shift neighboring layout.
- Reserve enough internal space for the maximum speech-reactive halo/deformation.

The orb's layout box stays stable even while its rendered contents react to speech.

---

# 7. Typography

Known current scale anchors:

```text
Headline ≈ 38.2 px / 1.78V
Status   ≈ 11.9 px / 0.55V
Transcript ≈ 12.7 px / 0.59V
```

Use live `SCALE.md` values if updated.

## Typography rules

- Match reference family/weight before tweaking letter spacing.
- Match line height and baseline position.
- Match apparent text opacity.
- Keep status subordinate to Jarvis identity.
- Avoid excessively bright secondary copy.
- Do not shrink text first when the window narrows; reduce gaps/padding first.

---

# 8. Composer / Action Geometry

Known current anchors:

```text
Composer min-height ≈ 44.9 px / 2.09V
Composer radius     ≈ 22.4 px / 1.04V
Send/action button  ≈ 33.4 px / 1.55V
```

The reference image remains the final authority for whether each control is visible in a given state.

## Interaction

- Hover should be subtle.
- Pressed state should feel immediate.
- Focus-visible state must be distinct.
- Disabled state must still remain legible.
- Icon geometry must be optically centered, not merely mathematically centered.

---

# 9. Voice State Design

## State: Idle

### Orb

- Static speech geometry.
- No speaking pulse.
- No fake breathing deformation.

### User loudness meter

- Zero/static unless the product is actively listening in idle.

### Status

- Use existing/reference-consistent idle language.

---

## State: Listening

### Orb

- Static.
- May retain its base light/glass treatment.
- Must not look like Jarvis is speaking.

### User loudness meter

- Driven by real mic input.
- Quiet room remains near baseline.
- User speech becomes visible immediately.

### Status

- Clearly communicates listening without relying solely on animation.

---

## State: User Speaking

### Orb

- Still static as a Jarvis speech visualizer.

### User loudness meter

- Strongly but smoothly follows microphone energy.
- Louder user speech yields greater amplitude.
- Visual response should not saturate during ordinary conversation.

### Important semantic separation

The user's voice activity does **not** drive the Jarvis orb.

---

## State: Thinking

### Orb

- No speech animation.

If the reference includes a thinking indicator, it should be visually distinct from speaking. Do not recycle the speech amplitude behavior.

### User meter

Reflect actual mic capture state only.

---

## State: Jarvis Speaking

### Orb

- Activated only while real Jarvis audio is playing.
- Motion amplitude maps to real output energy.
- Quiet phonemes create subtle response.
- Stronger phonemes create stronger but bounded response.
- Pauses settle toward neutral.

### User meter

If barge-in mic capture is active, it remains based on real microphone input.

If mic capture is paused during TTS, the user meter reflects that actual paused/zero state.

Do not drive the user meter from assistant audio for visual drama.

---

## State: Interrupted

- TTS output stops/ducks according to the real voice controller.
- Orb motion quickly releases to neutral.
- User meter transitions to the real active mic state.
- No lingering glow/pulse implying Jarvis is still talking.

---

## State: Error

- Stop speech-reactive motion.
- Preserve clear hierarchy.
- Error state should be readable and actionable without aggressive looping animation.

---

# 10. Orb Motion Contract

## Core behavior

The orb is a visualization of **Jarvis's real audible output**.

Define:

```text
E = normalized, gated, smoothed Jarvis output energy [0..1]
```

Speech-reactive properties may include:

```text
outerScale
coreScale
haloOpacity
haloRadius
ringDisplacement
surfaceDeformation
particleDisplacement (only if reference contains particles)
```

## Calibration envelope

Use a restrained starting envelope such as:

```text
outerScale = 1.00 + 0.03..0.06 × E
coreScale  = 1.00 + 0.02..0.04 × E
haloAlpha  = base + 0.10..0.25 × E
```

Tune to the reference and real voice.

## Prohibited orb behavior

- Idle pulse that looks like speech.
- Random deformation.
- Sine-wave speaking pattern unrelated to audio.
- Movement during thinking just to show activity.
- Movement after TTS has ended.

## Silence

At silence:

```text
E_target = 0
```

The orb should settle quickly and elegantly to a stable neutral rendering.

---

# 11. User Loudness Meter Contract

The user meter visualizes the actual mic signal.

## Input mapping

Conceptually:

```text
mic stream
→ measured amplitude/spectrum
→ noise gate
→ normalized level
→ attack/release smoothing
→ bars/waveform
```

## Visual behavior

### Silence

- Bars settle near their minimum height.
- No random dancing.

### Quiet speech

- Small but visible movement.

### Normal speech

- Mid-range movement with enough headroom.

### Loud speech

- Strong movement approaching the design cap.
- Avoid clipping-looking behavior unless the mic is genuinely clipping and the design intentionally indicates it.

### Muted

- Zero/static.
- Muted control state remains visible through icon/state treatment.

### No permission/no device

- Zero/static meter.
- Product-consistent status or error indicator.

---

# 12. Multi-Bar Shape Language

If the reference uses a compact group of bars:

- Center bars may have greater possible travel if shown by reference.
- Outer bars may be visually shorter if shown by reference.
- Every bar's instantaneous value must still come from real audio data.
- Use frequency-bin or deterministic weighting rather than randomness.
- Maintain a consistent base thickness and radius.
- Avoid a nightclub equalizer appearance unless the reference explicitly has it.

---

# 13. Signal Smoothing

Raw audio samples are too jittery for a refined UI.

Use:

- Noise floor/gate.
- Fast attack.
- Slower release.
- Hard clamp to `[0,1]`.
- Optional perceptual response curve.

Target feel:

- Immediate enough to feel synchronized.
- Smooth enough to feel premium.
- Fast enough to fall during genuine pauses.
- Never so slow that the orb keeps "speaking" after audio has stopped.

---

# 14. Interface Transition Motion

Signal-reactive animation and interface transitions are separate systems.

## Open

- Short, polished entrance.
- Preserve reference position.
- Avoid large travel distance.

## Close

- Short, clean exit.
- Audio visualization should stop/settle as the voice session closes.

## Expand/collapse

- Animate geometry only if current implementation/reference calls for it.
- Maintain control alignment.
- Avoid scaling the entire rendered panel as one bitmap-like object.

## Hover

- Subtle opacity/background/border response.

## Press

- Immediate tactile response.
- Avoid oversized bounce.

## Status changes

- Small crossfade/translate if needed.
- Avoid causing neighboring layout jumps.

---

# 15. Easing Guidance

For interface transitions, use the existing app motion system where available.

Desired character:

- Responsive.
- Smooth.
- No cartoon overshoot.
- No spring oscillation unless reference specifically demonstrates it.

Signal-reactive animation should use audio smoothing functions, not UI easing curves that lag far behind speech.

---

# 16. Color / Glass / Shadow Matching

Do not invent exact hex values in this document when the reference image is available. Extract them from the source image and implementation context.

Match these relationships:

- Panel surface vs page behind it.
- Border vs surface.
- Main text vs secondary status.
- Orb core vs halo.
- Mic control neutral vs active/muted.
- Composer surface vs panel surface.
- Hover/pressed contrast.

## Glass quality

If the reference uses glass:

- Keep blur bounded.
- Combine translucency with subtle border/inner highlight.
- Do not rely on blur alone.
- Avoid muddy gray stacking.
- Test against the actual app background, not an isolated blank page.

## Glow quality

- Preserve crisp core edges.
- Use soft falloff.
- Avoid clipping at orb container bounds.
- Avoid giant bloom that reduces legibility.

---

# 17. Icon Design

- Use the same icon family already used by the module/app unless the reference asset is custom.
- Match stroke weight.
- Match apparent size.
- Optical alignment is more important than identical SVG viewBox dimensions.
- Keep active/muted state clear.
- Do not introduce emoji or inconsistent icon styles.

---

# 18. Responsive Design

The module is desktop-first but must remain usable on narrower windows.

## Wide desktop

- Preserve full cinematic proportions.
- Match reference composition closely.

## Medium desktop

- Use clamp-based Jarvis-scoped sizing.
- Reduce inter-element gaps before typography.
- Preserve orb and primary controls.

## Narrow desktop/window

- Allow controlled wrapping/reflow only where necessary.
- Preserve mic and close controls.
- Keep body/content scrollable if needed.
- Avoid horizontal clipping.

## Very narrow fallback

- Prioritize function and hierarchy.
- Keep touch/click targets usable.
- Do not shrink text to unreadable sizes.

No global app transform or zoom is allowed.

---

# 19. Reduced-Motion Design

With `prefers-reduced-motion: reduce`:

## Orb

- Remove large deformation/scale travel.
- Preserve a subtle intensity/opacity change tied to real Jarvis energy so speaking state remains visible.

## Meter

- Keep actual level indication.
- Reduce smoothing overshoot and unnecessary transitions, not the truthful data itself.

## Panel transitions

- Shorten or remove ornamental motion.

The UI must remain fully understandable without large animation.

---

# 20. Accessibility Design

## Controls

Every icon control has:

- Accessible name.
- Visible focus state.
- Correct disabled state.
- Correct pressed/muted state where applicable.

## Status

- Use text as well as color/animation.
- Avoid rapid screen-reader announcements for every intermediate voice-state fluctuation.

## Contrast

- Functional text/control contrast must remain sufficient even with glass effects.

## Target size

- Keep practical hit areas even if icons visually appear compact.

---

# 21. Performance Design Budget

The visual target is premium, but effects must fit desktop-app performance constraints.

- One visualization RAF loop.
- Reuse sample buffers.
- No per-frame DOM layout measurement.
- Prefer transforms/opacity over width/left/top for high-frequency changes.
- Use blur/filter carefully.
- Do not run heavy orb effects while hidden.
- If canvas/WebGL is used, avoid unnecessary high DPR and redraw work.
- No leaked contexts/nodes on repeated open/close.

A polished UI that drops frames during speech is not accepted.

---

# 22. Audio Ownership Design

The visualization is a **consumer** of the voice pipeline.

It should not become a second independent voice engine.

- Reuse existing mic stream.
- Reuse existing playback source/energy callback.
- Stop only resources owned by the visualization.
- Do not break TTS output routing.
- Do not alter voice gain just to improve visual energy readings.
- Normalize measurements in the visualization layer instead.

---

# 23. Echo / Barge-In Design

When Jarvis speaks and the microphone remains live:

- The meter still means "user microphone input."
- Use actual acoustic echo cancellation/voice-controller semantics.
- A barge-in attempt should be visible through the real mic signal.
- Once interruption is accepted, Jarvis output stops/ducks and the orb releases.

If the product disables mic capture during assistant speech, the meter should honestly show the disabled/zero state rather than faking user activity.

---

# 24. Expanded/Collapsed Consistency

If both expanded and collapsed reference states exist:

- Preserve the same visual identity.
- Orb behavior remains identical semantically.
- Mic behavior remains identical semantically.
- Controls may reflow, but their functions/states remain the same.
- Transitions must not disconnect/recreate the entire voice graph unnecessarily.
- Expanded/collapsed switching must not restart microphone permissions.

---

# 25. Visual QA Checklist

- [ ] Panel bounds match reference.
- [ ] Panel position matches reference.
- [ ] Corner radius matches reference.
- [ ] Panel surface/glass matches reference.
- [ ] Border strength matches reference.
- [ ] Shadow/glow depth matches reference.
- [ ] Orb size matches reference.
- [ ] Orb left/top alignment matches reference.
- [ ] Jarvis title baseline matches reference.
- [ ] Status baseline matches reference.
- [ ] Transcript/body text matches reference.
- [ ] Waveform/meter position matches reference.
- [ ] Mic control size/position matches reference.
- [ ] Close control size/position matches reference.
- [ ] Composer geometry matches reference where present.
- [ ] Hover state is polished.
- [ ] Pressed state is polished.
- [ ] Focus-visible state is clear.
- [ ] Expanded state matches reference if applicable.
- [ ] Collapsed state matches reference if applicable.
- [ ] Narrow-window state remains usable.
- [ ] No unrelated VibeSpace UI changed.

---

# 26. Motion QA Checklist

- [ ] Orb speech motion is completely absent while Jarvis is silent.
- [ ] Orb begins responding only when real Jarvis audio begins.
- [ ] Orb response strength follows real output amplitude.
- [ ] Orb settles during real speech pauses.
- [ ] Orb stops after TTS completion.
- [ ] Orb stops after cancellation/interruption.
- [ ] User meter responds to real microphone input.
- [ ] Whisper produces smaller meter response than loud speech.
- [ ] Silence settles near zero.
- [ ] Muted mic produces zero/static meter.
- [ ] User speech does not drive Jarvis orb.
- [ ] TTS signal is not intentionally substituted for user mic level.
- [ ] Animation is smooth without excessive lag.
- [ ] Reduced-motion mode remains informative.

---

# 27. Interaction QA Checklist

- [ ] Open works.
- [ ] Close works.
- [ ] Expand/collapse works if present.
- [ ] Mic mute/unmute works.
- [ ] Focus navigation works.
- [ ] Keyboard activation works.
- [ ] Listening state is clear.
- [ ] Thinking state is clear.
- [ ] Speaking state is clear.
- [ ] Interruption/barge-in works according to product behavior.
- [ ] Permission-denied state is graceful.
- [ ] Missing-device state is graceful.
- [ ] Reopening the module does not duplicate animation/audio behavior.

---

# 28. Out-of-Scope / Reject List

Reject any implementation that depends on:

- Global CSS zoom.
- Global font-size changes.
- Global layout shifts.
- Random waveform animation.
- Fake orb speech pulses.
- Static screenshot replacement.
- Unwired mic/close/send buttons.
- Broad visual redesign outside Jarvis.
- A separate unnecessary mic permission flow.
- Repeated AudioContext creation.
- Performance-heavy visual noise that is not in the reference.

---

# 29. Design Acceptance Standard

The design is finished only when a viewer can place the reference beside the running VibeSpace Jarvis Voice Module and see the same composition, hierarchy, scale, and visual character, while the live version improves upon a static screenshot only by adding **truthful** real-time voice behavior.

The orb must feel like Jarvis is speaking because it is literally reacting to Jarvis's output signal. The loudness display must feel responsive to the user because it is literally reacting to the user's microphone signal.

Nothing else in VibeSpace should need to change for that result to exist.
