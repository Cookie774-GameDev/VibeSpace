---
name: jarvis-voice-ui-clone
description: Rebuild and polish VibeSpace's Jarvis Voice module from a visual reference while wiring the assistant orb and user loudness meter to real audio energy.
---

# Jarvis Voice UI Clone Skill

## Purpose

Use this skill when implementing, repairing, visually matching, or production-polishing the **VibeSpace Jarvis Voice Module** from a supplied reference image.

The skill has two equally important responsibilities:

1. Achieve high visual fidelity to the reference without disturbing unrelated VibeSpace UI.
2. Ensure all voice-reactive visuals are driven by real audio data rather than simulated animation.

This skill is intentionally narrow. It must not become a pretext for redesigning the rest of VibeSpace.

---

# Trigger Conditions

Apply this skill when a task asks for one or more of the following:

- Clone the Jarvis Voice UI from a reference image.
- Repair Jarvis Voice spacing, scale, colors, borders, glow, or layout.
- Make the Jarvis orb react to Jarvis speech.
- Make the mic/waveform react to real user volume.
- Polish Jarvis Voice animations.
- Match expanded/collapsed Jarvis states.
- Fix Jarvis Voice responsiveness or accessibility.
- Connect a reference-matched Jarvis interface to the real voice pipeline.

---

# Repository Context

Default target for this task family:

- Repository: `Cookie774-GameDev/VibeSpace`
- PR: `#31`
- Branch: `agent/pr30-fixes-and-updates`
- Geometry contract: `/SCALE.md`
- Scope selectors may include: `#jarvis-panel`, `.jarvis-glass-panel`

Always verify the live repository before relying on filenames or component names.

---

# Non-Negotiable Invariants

## Invariant A — Jarvis-only scope

Never fix Jarvis by globally scaling or restyling VibeSpace.

## Invariant B — Reference image is appearance truth

Do not "improve" away deliberate reference-image geometry, hierarchy, color, glass, glow, or spacing simply because a generic design system would choose something else.

## Invariant C — `SCALE.md` controls geometry

Preserve established Jarvis-specific scale/position behavior unless the current explicit reference requirement supersedes it.

## Invariant D — Orb motion is assistant-audio truthful

The Jarvis orb's speech animation must be driven from real Jarvis/TTS output energy and must not run as speech motion while Jarvis is silent.

## Invariant E — User meter is microphone truthful

The user loudness/waveform display must be driven from the real microphone stream. Loud user input must produce stronger response than quiet input.

## Invariant F — No fake activity

Never use randomness, looping keyframes, or elapsed-time functions to imitate audio level.

## Invariant G — lifecycle ownership matters

Never stop a shared mic stream or destroy a shared audio graph that the Jarvis component does not own.

---

# Workflow

## Phase 1 — Reconnaissance

Identify:

- Jarvis root component.
- Module styles.
- Voice session controller.
- TTS playback implementation.
- Mic stream owner.
- Mute/listening state owner.
- Interrupt/barge-in path.
- Existing visualizer utilities.
- Existing test utilities.
- Relevant CSS selectors and responsive rules.

Search for:

```text
Jarvis
voice
getUserMedia
MediaStream
AudioContext
AnalyserNode
createMediaStreamSource
createMediaElementSource
speech
TTS
playback
isSpeaking
mic
mute
waveform
#jarvis-panel
.jarvis-glass-panel
```

Do not edit until the actual data flow is understood.

---

# Visual Reconstruction Procedure

## 1. Measure macro geometry

From the reference and `SCALE.md`, establish:

- Panel bounds.
- Viewport anchoring.
- Orb bounds.
- Major control bounds.
- Header/body/composer divisions.
- Expanded/collapsed dimensions if applicable.

Macro geometry comes before color polishing.

## 2. Match internal rhythm

Correct:

- Padding.
- Gaps.
- Baselines.
- Alignment.
- Separator positions.
- Control optical centering.

## 3. Match typography

Compare:

- Font family already used by the app/reference.
- Weight.
- Size.
- Line height.
- Letter spacing.
- Opacity.
- Hierarchy.

## 4. Match rendering treatment

Compare:

- Background transparency.
- Backdrop blur.
- Border tone/opacity.
- Inner highlights.
- Drop shadows.
- Glow falloff.
- Orb gradients/textures.

Do not add arbitrary effects absent from the image.

## 5. Match interaction states

Check:

- Hover.
- Active/pressed.
- Focus-visible.
- Disabled.
- Muted.
- Listening.
- Speaking.
- Error.
- Expand/collapse.

---

# Scale Contract Guidance

Read the current repository `SCALE.md`; its live contents override this summary.

Known anchors from the current contract include approximately:

```text
1V ≈ 21.50 px
1H = reference panel width / 12
horizontal panel padding ≈ 22.7 px / 1H
vertical panel padding ≈ 20.5 px / 1V
orb/avatar ≈ 80 px / 3.72V
headline ≈ 38.2 px / 1.78V
status ≈ 11.9 px / 0.55V
transcript ≈ 12.7 px / 0.59V
panel radius ≈ 32.2 px / 1.50V
composer min-height ≈ 44.9 px / 2.09V
composer radius ≈ 22.4 px / 1.04V
send button ≈ 33.4 px / 1.55V
```

The contract also establishes Jarvis-scoped viewport anchoring rather than whole-app scaling.

---

# Audio Analysis Architecture

## Core principle

The UI visualizer consumes **real signal measurements**; it does not generate a visual rhythm independently.

Use one lightweight analysis pipeline per relevant audio source.

---

# User Microphone Level

## Preferred source

Use the voice session's existing `MediaStream`.

Avoid requesting a second mic stream because duplicate capture can cause:

- Multiple permission flows.
- Device contention.
- More CPU usage.
- Different audio processing paths.
- Broken mute semantics.

## Web Audio analysis

A typical pipeline is:

```text
MediaStream
→ MediaStreamAudioSourceNode
→ AnalyserNode
→ Float32Array time-domain samples
→ RMS + peak
→ noise gate
→ normalization
→ attack/release smoothing
→ visual level
```

### RMS

For normalized floating-point samples `x[i]`:

```text
rms = sqrt((Σ x[i]^2) / N)
```

### Peak

```text
peak = max(abs(x[i]))
```

### Noise gate

A reasonable starting region is:

```text
gate ≈ 0.015 .. 0.03 RMS
```

Do not treat that range as universal. If the app already calibrates mic noise or gain, reuse that information.

### Normalization

Conceptual form:

```text
raw = clamp((rms - gate) / (ceiling - gate), 0, 1)
```

Optionally apply perceptual shaping:

```text
visual = pow(raw, gamma)
```

where a gamma below `1` can make ordinary speech visible without destroying the distinction between quiet and loud input.

### Attack/release

Use separate smoothing speeds:

```text
if target > current:
    current += (target - current) * attack
else:
    current += (target - current) * release
```

Typical tuning space at display-frame cadence:

```text
attack  ≈ 0.25 .. 0.50
release ≈ 0.05 .. 0.15
```

Tune by feel and test with actual speech.

### Required truth table

```text
no stream        -> 0
ended track      -> 0
muted track      -> 0
permission denied-> 0 + error/permission UI
room silence     -> near 0 after noise gate
quiet speech     -> low
normal speech    -> medium
loud speech      -> high
```

---

# Multi-Bar User Meter

If the design includes multiple bars, do not use random variation.

Preferred approaches:

## Spectrum-bin approach

Use `getFloatFrequencyData` or `getByteFrequencyData`; map real frequency ranges into display bars.

Example conceptual bands:

```text
bar 1 <- low-mid voice energy
bar 2 <- mid voice energy
bar 3 <- core speech energy
bar 4 <- upper-mid energy
bar 5 <- high speech/detail energy
```

Apply a shared gate and bounded smoothing.

## Deterministic amplitude-shaping approach

If FFT is unnecessary, derive bar shapes deterministically from the same actual RMS/peak pair. Keep all bars tied to measured input.

Never call `Math.random()` for visual energy.

---

# Jarvis Output Level

## Goal

Produce a normalized `jarvisEnergy` that represents the actual assistant audio currently reaching playback.

## Preferred source hierarchy

1. PCM level or energy event already exposed by TTS/playback.
2. Existing Web Audio graph tap.
3. Single `AnalyserNode` attached to the playback source.
4. Worklet/stream analysis when the playback architecture requires it.

## `HTMLAudioElement` caution

If playback uses a media element and `createMediaElementSource(...)` is appropriate:

- Create the media source node once for that element/context.
- Reuse it.
- Preserve connection to the destination.
- Do not create a new source node for every utterance.
- Respect CORS/security behavior for remote media.

Do not break playback merely to obtain visualization data.

## PCM/stream playback

If TTS already delivers PCM chunks, compute RMS/peak directly from the samples or expose a tiny read-only level callback before/while they are sent to the audio sink.

This is often cleaner than rebuilding the audio graph.

## Binary speaking state fallback

A binary `isSpeaking` flag is not a substitute for loudness-driven motion. It may gate whether the visualization is allowed to move, but it should not fabricate amplitude.

If actual output signal access is technically impossible due to a verified external limitation, keep the orb static rather than inventing random speech amplitude, document the limitation, and expose the narrowest architecture change needed to make real analysis possible.

---

# Orb Transfer Function

Let:

```text
E = normalized smoothed Jarvis output energy in [0,1]
```

Then drive only restrained properties. A calibration starting point:

```text
orbScale       = 1.0 + 0.045 * E
coreScale      = 1.0 + 0.030 * E
glowAlpha      = baseGlow + 0.18 * E
haloExpansion  = baseHalo + smallDelta * E
surfaceMotion  = pow(E, 0.75)
```

These numbers are not sacred. Tune them to the reference.

## Silence rule

If the output signal is under the silence gate or the voice state is not `jarvis_speaking`:

```text
E_target = 0
```

The orb settles to neutral with a short release curve.

There must be no autonomous speech-like movement after settlement.

---

# Suggested Data Interfaces

Adapt names to the codebase:

```ts
type VoiceUiState =
  | 'idle'
  | 'listening'
  | 'user_speaking'
  | 'thinking'
  | 'jarvis_speaking'
  | 'interrupted'
  | 'error';

type AudioLevel = {
  rms: number;
  peak: number;
  normalized: number;
  active: boolean;
};
```

Potential hooks/controllers:

```text
useMicLevel(stream)
useJarvisOutputLevel(playbackSource)
useJarvisVoicePresentationState(...)
```

Keep raw frame-rate values out of broad application state whenever possible.

---

# Frame Loop Strategy

Use a single `requestAnimationFrame` loop for the module's high-frequency visualization work.

Within the loop:

1. Read mic analyser data if active.
2. Read Jarvis analyser data if active.
3. Compute gated/smoothed values.
4. Update narrowly scoped visual properties.
5. Request the next frame only while needed, or keep one cheap loop while module is visible if architecture is simpler.

Avoid:

- One RAF per waveform bar.
- 60 React state updates per second for the whole panel.
- Layout reads followed by layout writes each frame.
- Unbounded filter animation.

---

# CSS Variable Bridge

A low-overhead pattern is:

```text
--jarvis-energy: 0..1
--mic-level: 0..1
--mic-band-1: 0..1
--mic-band-2: 0..1
...
```

Then the presentation layer can map these into transforms/opacity/height while the source data remains real.

Do not use CSS keyframes to create signal values.

---

# State-to-Motion Contract

| State | Orb speech motion | User meter | Notes |
|---|---:|---:|---|
| `idle` | Off | Zero unless actively capturing | No fake idle speaking motion |
| `listening` | Off | Real mic | Quiet remains quiet |
| `user_speaking` | Off | Real mic, stronger with loudness | Orb is not a user meter |
| `thinking` | Off | Based on actual capture state | No speech pulse |
| `jarvis_speaking` | Real TTS energy | Real mic if barge-in enabled; otherwise capture-state behavior | Never relabel TTS as user level |
| `interrupted` | Release to zero | Real current mic state | Cancel stale output animation |
| `error` | Off | Zero or actual safe capture state | No looping attention animation |

---

# Echo and Barge-In

If the user mic remains active while Jarvis speaks, speaker output may physically re-enter the microphone.

Use the product's established strategy:

- Browser/system acoustic echo cancellation.
- `echoCancellation` constraints where appropriate.
- Noise suppression.
- Existing ducking/barge-in logic.

Do not solve echo by replacing the real user meter with the assistant output signal.

If capture is disabled during TTS, meter behavior must reflect that true capture state.

---

# Audio Lifecycle Checklist

On initialization:

- Reuse shared context/stream where possible.
- Create analyser nodes once.
- Allocate typed arrays once and reuse them.
- Attach listeners once.

On playback change:

- Update the active source without duplicating nodes.
- Reset stale energy when the utterance ends.

On mute/track end:

- Target meter level to zero.

On interruption:

- Stop/duck the real playback.
- Target Jarvis energy to zero.

On unmount/close:

- Cancel RAF.
- Remove listeners.
- Disconnect owned analyser/source nodes.
- Stop only owned tracks.
- Release owned resources.

On reopen:

- Verify there is no node/listener multiplication.

---

# Motion Design Rules

Signal-driven animation:

- Has no independent loop rhythm.
- Responds to actual energy.
- Uses attack/release smoothing.
- Clamps outliers.
- Returns to neutral at silence.

UI transitions:

- May use CSS keyframes/transitions or the existing animation library.
- Should use reference-consistent timing/easing.
- Must not masquerade as audio data.

---

# Reduced Motion

Under `prefers-reduced-motion: reduce`:

- Reduce orb spatial scale/deformation.
- Prefer opacity/intensity changes over large movement.
- Keep meter data useful.
- Shorten or remove ornamental open/close transitions.
- Preserve functional state communication.

---

# Accessibility Rules

- Label icon-only buttons.
- Expose mic pressed/muted state.
- Keep keyboard focus visible.
- Preserve logical focus order.
- Avoid color-only state communication.
- Use appropriate live-status semantics sparingly.
- Keep hit targets usable.

---

# Responsive Rules

- Keep changes scoped to Jarvis.
- Respect `SCALE.md` desktop geometry.
- Use CSS variables/clamps for smaller windows.
- Reduce whitespace before essential typography/control size.
- Keep mic and close controls visible.
- Allow internal scrolling where needed.
- Never globally zoom VibeSpace.

---

# Testing Matrix

## Signal-processing unit tests

Feed known arrays:

### Digital silence

```text
[0, 0, 0, ...] -> rms 0 -> normalized 0
```

### Quiet tone/sample

Expected level is above zero but low.

### Larger-amplitude sample

Expected normalized level is greater than the quiet sample.

### Gate behavior

Low noise below configured gate settles to zero.

### Attack/release

Rising target responds faster than falling target when configured that way.

## UI state tests

Verify:

- Idle orb does not animate as speech.
- Listening mic meter can move while orb remains static.
- User speech does not animate the Jarvis orb.
- `jarvis_speaking` gates orb animation.
- TTS end zeros Jarvis energy.
- Mute zeros user meter.
- Interruption removes stale speaking state.

## Integration/manual tests

- Whisper into mic.
- Speak normally.
- Speak loudly without clipping.
- Mute/unmute.
- Let Jarvis speak a quiet segment and louder segment.
- Interrupt Jarvis.
- Close/open panel repeatedly.
- Switch input device if supported.
- Run reduced-motion mode.

---

# Visual QA Procedure

At the canonical reference viewport:

1. Capture implementation.
2. Overlay with reference.
3. Compare panel bounds.
4. Compare orb bounds.
5. Compare text baselines.
6. Compare waveform/control positions.
7. Compare borders/radii.
8. Compare shadows/glass/glow.
9. Compare interaction-state screenshots.
10. Re-run after each geometry change.

Use objective deltas where possible rather than eyeballing every iteration.

---

# Anti-Patterns — Reject Immediately

```text
Math.random() waveform values
setInterval(() => fakeLevel(), ...)
infinite idle pulse described as speech animation
CSS-only audio bars that move without microphone input
TTS isPlaying boolean mapped to arbitrary sine-wave amplitude
whole-app transform scaling
global typography override
creating a second mic stream without architectural need
creating a new AudioContext on every render
creating multiple MediaElementSource nodes for one element
stopping a mic track owned by the parent session
React rerendering the entire panel at audio frame rate
```

---

# Definition of Done

The skill is complete only when all of the following are true:

- UI visibly matches the reference at the target viewport.
- `SCALE.md` geometry rules remain respected.
- No unrelated app UI changed.
- User mic visualization is real-signal-driven.
- Louder user speech yields greater meter response.
- Jarvis orb visualization is real-output-signal-driven.
- Orb speech motion is off while Jarvis is silent.
- Interrupt/cancel clears output motion.
- Audio resources clean up correctly.
- Reopen cycles do not leak or duplicate behavior.
- Reduced motion works.
- Keyboard/accessibility behavior is intact.
- Type/lint/test/build checks relevant to the repo pass.
- Any unavoidable technical limitation is explicitly documented rather than hidden behind fake behavior.

---

# Final Skill Rule

**Truthful signal first, reference fidelity second, implementation elegance third—but all three are required for production readiness. Never trade real audio correctness for decorative motion, and never fix a Jarvis-only visual problem by altering the rest of VibeSpace.**
