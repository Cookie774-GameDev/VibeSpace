# Jarvis Voice Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the compact and expanded Jarvis voice module from the supplied references with real microphone-reactive bars, speaking-reactive globe motion, exact voice transcript roles, and a working persisted model selector.

**Architecture:** Preserve `VoiceModal` as lifecycle owner and the existing presentation boundaries. Add a resource-owning voice-signal controller and a connected-model selector, then restyle and recompose the current header, waveform, globe, transcript, and expanded Command Center.

**Tech Stack:** React 19, TypeScript, Zustand, Web Audio API, Motion, Vitest, Testing Library, Tailwind/theme CSS.

## Global Constraints

- Keep the running VibeSpace desktop process alive; use Vite hot reload for frontend changes.
- Never infer microphone loudness from transcript length.
- Persist model selection through `useAuthStore.setChatModelSelection`.
- Preserve exact account/chat binding for transcript and embedded Command Center data.
- Respect reduced motion, forced colors, keyboard access, and project theme tokens.
- Do not introduce a native WebView or external runtime dependency.

---

### Task 1: Voice signal controller

**Files:**
- Create: `app/src/features/voice/voiceSignal.ts`
- Test: `app/src/features/voice/voiceSignal.test.ts`

**Interfaces:**
- Produces: `createVoiceSignalController(levelRef, dependencies?)`
- Produces: `{ startListening(): Promise<void>; startSpeaking(): void; stop(): void }`
- Guarantees: `levelRef.current` remains in `0..1`; `stop()` releases tracks, analyser resources, animation frames, and timers.

- [ ] **Step 1: Write failing tests**

Test that quiet/loud analyser samples produce increasing bounded levels, attack rises faster than release falls, speaking mode produces a nonzero bounded envelope, and `stop()` zeros the ref and releases every resource.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/features/voice/voiceSignal.test.ts --maxWorkers=1`

Expected: FAIL because `voiceSignal.ts` does not exist.

- [ ] **Step 3: Implement minimal controller**

Use `getUserMedia({ audio: true })`, an `AnalyserNode` time-domain buffer, RMS/peak normalization, and attack/release smoothing. Use a deterministic multi-sine envelope for speaking mode because Web Speech synthesis does not expose output PCM.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/features/voice/voiceSignal.test.ts --maxWorkers=1`

Expected: all signal-controller tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- app/src/features/voice/voiceSignal.ts app/src/features/voice/voiceSignal.test.ts
git commit -m "feat(voice): add live signal energy controller"
```

### Task 2: Working voice model selector

**Files:**
- Create: `app/src/features/voice/VoiceModelSelector.tsx`
- Test: `app/src/features/voice/VoiceModelSelector.test.tsx`

**Interfaces:**
- Consumes: `useAccessibleChatModels()`
- Consumes: `ChatModelSelection`
- Produces: `<VoiceModelSelector selection onSelect />`

- [ ] **Step 1: Write failing tests**

Render connected and unavailable options. Assert the current provider/model/connection value is selected, unavailable entries are disabled, and changing selection calls `onSelect(selectionFromOption(...))` with the exact connection.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/features/voice/VoiceModelSelector.test.tsx --maxWorkers=1`

Expected: FAIL because `VoiceModelSelector.tsx` does not exist.

- [ ] **Step 3: Implement grouped native selector**

Use one accessible `<select aria-label="Jarvis response model">` with provider `<optgroup>` sections. Preserve option connection identity in the option value and resolve the selected option from `selectionOptionId`.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/features/voice/VoiceModelSelector.test.tsx --maxWorkers=1`

Expected: all model-selector tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- app/src/features/voice/VoiceModelSelector.tsx app/src/features/voice/VoiceModelSelector.test.tsx
git commit -m "feat(voice): add connected model selector"
```

### Task 3: Reference-faithful signal instrument

**Files:**
- Modify: `app/src/features/voice/JarvisVoiceHeader.tsx`
- Modify: `app/src/features/voice/JarvisVoiceHeader.test.tsx`
- Modify: `app/src/features/voice/VoiceActivityWaveform.tsx`
- Modify: `app/src/features/voice/VoiceActivityWaveform.test.tsx`
- Modify: `app/src/features/voice/Orb.tsx`
- Modify: `app/src/features/voice/Orb.test.tsx`
- Create: `app/src/features/voice/voice-module.css`

**Interfaces:**
- Consumes: one `levelRef` from Task 1 for listening and speaking.
- Produces: reference-faithful compact header with `data-voice-energy`.

- [ ] **Step 1: Write failing component tests**

Assert that speaking activates waveform drawing, higher signal produces taller bars, the globe consumes live energy, microphone and globe share the listening toggle, and compact geometry/accessibility markers are present.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/features/voice/JarvisVoiceHeader.test.tsx src/features/voice/VoiceActivityWaveform.test.tsx src/features/voice/Orb.test.tsx --maxWorkers=1`

Expected: FAIL on speaking activity and energy-aware globe assertions.

- [ ] **Step 3: Implement visual composition**

Build the amber signal globe from nested rings/filaments, enlarge the identity hierarchy, center the waveform, add the ringed microphone control and divider, and express compact/expanded geometry through `voice-module.css`. Drive globe CSS custom properties from the same smoothed ref sampled by animation frame.

- [ ] **Step 4: Verify GREEN**

Run the Task 3 command again.

Expected: all header, waveform, and globe tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- app/src/features/voice/JarvisVoiceHeader.tsx app/src/features/voice/JarvisVoiceHeader.test.tsx app/src/features/voice/VoiceActivityWaveform.tsx app/src/features/voice/VoiceActivityWaveform.test.tsx app/src/features/voice/Orb.tsx app/src/features/voice/Orb.test.tsx app/src/features/voice/voice-module.css
git commit -m "feat(voice): match Jarvis signal instrument reference"
```

### Task 4: Expanded transcript and lifecycle integration

**Files:**
- Modify: `app/src/features/voice/VoiceModal.tsx`
- Modify: `app/src/features/voice/VoiceModal.turn.test.tsx`
- Modify: `app/src/features/voice/JarvisVoiceTranscript.tsx`
- Modify: `app/src/features/voice/JarvisVoiceTranscript.test.tsx`

**Interfaces:**
- Consumes: Task 1 signal controller.
- Consumes: Task 2 model selector.
- Produces: expanded reference layout and complete cleanup behavior.

- [ ] **Step 1: Write failing integration tests**

Assert listening starts mic signal, speaking switches to speaking signal without mic capture, idle/close stops signal, expanded mode renders a working model selector, and separate consecutive user/assistant messages remain labeled `You` and `Jarvis`.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/features/voice/VoiceModal.turn.test.tsx src/features/voice/JarvisVoiceTranscript.test.tsx --maxWorkers=1`

Expected: FAIL because the modal does not yet own the signal controller or model selector.

- [ ] **Step 3: Integrate lifecycle and layout**

Replace transcript-length level assignment with controller ownership. Mount `VoiceModelSelector` in the expanded disclosure header, persist valid changes through the auth store, retain Context Map and embedded Command Center below the transcript, and apply reference geometry classes.

- [ ] **Step 4: Verify GREEN**

Run the Task 4 command again.

Expected: all voice-turn and transcript integration tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- app/src/features/voice/VoiceModal.tsx app/src/features/voice/VoiceModal.turn.test.tsx app/src/features/voice/JarvisVoiceTranscript.tsx app/src/features/voice/JarvisVoiceTranscript.test.tsx
git commit -m "feat(voice): integrate expanded Jarvis command center"
```

### Task 5: Full verification and live refinement

**Files:**
- Modify only Task 1–4 files when verification exposes a defect.

**Interfaces:**
- Produces: verified source and live hot-reloaded VibeSpace UI.

- [ ] **Step 1: Run focused voice suite**

Run: `npx vitest run src/features/voice --maxWorkers=1`

Expected: zero failures.

- [ ] **Step 2: Run static verification**

Run: `npm run typecheck`

Run: `npx prettier --check src/features/voice`

Expected: exit code `0` for both.

- [ ] **Step 3: Run production build**

Run: `npm run build`

Expected: build completes with exit code `0`.

- [ ] **Step 4: Inspect live compact and expanded states**

Confirm the running desktop PID remains resident, port `5173` is listening, compact/expanded layouts do not overlap at desktop and narrow widths, microphone volume changes bar height, speaking moves the globe, transcript roles are correct, and model changes persist.

- [ ] **Step 5: Commit verification refinements**

Stage only task-owned files and commit any necessary refinements with:

```powershell
git commit -m "fix(voice): refine live Jarvis module behavior"
```
