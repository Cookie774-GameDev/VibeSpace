# Jarvis Voice Module Reference Design

## Objective

Rebuild the floating Jarvis voice module to match the two supplied Default Theme references while preserving the existing voice session, transcription, speech, drag, accessibility, and Command Center behavior.

The module has two states:

- **Compact:** a single horizontal instrument containing the animated signal globe, Jarvis identity and state, voice-reactive waveform, microphone control, and close action.
- **Expanded:** the same instrument as a fixed header over a Command Center containing a working model selector and a chronological `You` / `Jarvis` transcript.

## Reference authority

The visual authority is:

1. `ChatGPT Image Jul 31, 2026, 01_45_30 PM (1).png` for compact geometry.
2. `ChatGPT Image Jul 31, 2026, 01_45_31 PM (2).png` for expanded geometry.

The images define proportion, hierarchy, restrained amber light, border treatment, waveform placement, and transcript rhythm. Product behavior and accessibility remain authoritative when the images omit a state.

## Chosen architecture

Keep the existing component boundaries and introduce two focused units:

- `voiceSignal.ts` owns live microphone energy and speaking-energy synthesis through one mutable `0..1` signal reference.
- `VoiceModelSelector.tsx` renders connected, usable model options and persists selection through `useAuthStore.setChatModelSelection`.

`VoiceModal.tsx` remains the lifecycle owner. It starts real microphone metering only while listening, switches to a bounded speech envelope while Jarvis speaks, and stops all signal resources on state change or unmount. `JarvisVoiceHeader`, `VoiceActivityWaveform`, `Orb`, and `JarvisVoiceTranscript` remain presentation components.

This avoids a native overlay and therefore avoids creating another independent WebView lifecycle.

## Visual system

### Palette

- **Obsidian:** `#110E0B` — opaque panel base.
- **Ember glass:** `#24170F` — subtle header and control lift.
- **Solar amber:** `#F4A63A` — active signal and primary status.
- **Copper filament:** `#A95E22` — borders and low-energy waveform.
- **Warm ivory:** `#F3E9D8` — primary text.
- **Ash bronze:** `#9A8978` — secondary text and inactive controls.

Application theme tokens must supply the final values; these names define the intended relationships, not new global literals.

### Typography

- Existing VibeSpace UI font remains the body and control face.
- Jarvis identity uses the existing display hierarchy at a larger, calmer weight.
- Transcript speakers use medium weight; message text stays regular.
- Timestamps are optional metadata derived from message creation time and never replace speaker labels.

### Geometry

Compact desktop target: approximately `760 × 136 CSS px`.

Expanded desktop target: approximately `780 × min(680, viewport - 32) CSS px`.

The panel reflows to `calc(100vw - 24px)` below `52rem`. Controls remain at least `32px` and keyboard reachable. The expanded transcript scrolls internally while the header remains visible.

### Signature element: signal globe

The globe is a wireframe-like amber energy field:

- Listening: scale and filament brightness follow the real smoothed microphone signal.
- Thinking: a restrained orbital drift indicates processing.
- Speaking: a deterministic, bounded output-energy envelope moves the field while Jarvis audio is active.
- Idle/paused/error: continuous nonessential motion stops or is reduced.
- Reduced motion: no continuous transform; brightness/state changes remain visible.

## Signal data flow

```text
getUserMedia microphone
  -> Web Audio analyser
  -> RMS + peak normalization
  -> attack/release smoothing
  -> shared levelRef (0..1)
  -> waveform bar height + globe energy

Jarvis speech start/end events
  -> bounded speech envelope
  -> shared levelRef (0..1)
  -> waveform + globe energy
```

Microphone energy must never be inferred from transcript length. Meter failures are nonfatal: speech recognition continues and the visual settles to its idle floor.

## Compact interaction

- Clicking the globe or microphone toggles listening.
- During thinking or speaking, the same control stops the response and returns control to the user.
- Clicking the body or the Command Center disclosure expands the panel.
- Close ends the voice module through the existing cleanup path.
- Drag begins only from noninteractive header space.

## Expanded Command Center

The expanded panel contains:

1. Header instrument identical to compact state.
2. Command Center disclosure title.
3. Connected-model selector, grouped by provider and connection.
4. Voice transcript rows labeled exactly `You` and `Jarvis`.
5. Existing context map and embedded command-center evidence below the transcript.

Changing the model updates the same persisted chat model selection used by regular Chat. Unavailable models remain visible but disabled. The active option is derived from the exact provider/model/connection identity.

## Transcript behavior

- Include committed user, assistant, and agent messages from the bound voice chat.
- Show the live interim user transcript as a final pending row.
- Keep the newest content in view only while the user remains near the bottom.
- Preserve `Show more` / `Show less` for long messages.
- Render multiple consecutive responses as separate rows; never merge roles or display placeholder speaker letters.

## Error and cleanup behavior

- Microphone permission and capture errors retain the existing visible error state.
- Signal metering errors degrade only the animation, not recognition.
- Model selection failure leaves the previous selection unchanged and exposes existing provider/settings recovery paths.
- Closing or unmounting stops analyser frames, audio tracks, timers, recognition, and speech through their respective owners.
- Backgrounding cancels animation work; foregrounding resumes only when the voice state is active.

## Accessibility

- Preserve the polite atomic status for voice state.
- Keep the waveform decorative.
- Give the globe, microphone, close, disclosure, and model selector explicit accessible names.
- Preserve native select semantics for the first implementation.
- Respect reduced motion and forced colors.
- Maintain visible focus and minimum touch targets.

## Test strategy

- Unit-test signal normalization, attack/release smoothing, mic cleanup, and speech envelope bounds.
- Verify waveform height increases with actual signal ref changes and supports speaking state.
- Verify globe exposes live energy and changes active presentation without rerender loops.
- Verify model options, disabled states, and persisted selection.
- Verify expanded transcript renders separate `You` and `Jarvis` rows plus partial text.
- Verify VoiceModal starts/stops the signal owner on listening/speaking/close transitions.
- Run the focused voice suite, TypeScript, formatting, production build, and live visual inspection at compact and expanded widths.

## Non-goals

- No native child WebView.
- No new transcription provider.
- No provider-message scraping.
- No change to the Jarvis Command Center authority or account binding.
- No broad theme redesign outside the voice surface.
