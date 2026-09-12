# Voice Turn-Taking and Microphone Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and execute inline; subagents are prohibited by the user.

**Goal:** Complete Prompt 15 with explicit phrase submission, one 1–60 second pause control, and a real local microphone capture test.

**Architecture:** Keep the existing stores and voice event flow. Consolidate timeout policy in `voiceConversation.ts`, adapt `VoiceModal.tsx`, and isolate microphone capture/resource cleanup in a small module and panel component.

**Tech Stack:** React, TypeScript, Zustand, Web MediaDevices/Web Audio/MediaRecorder, Vitest, Testing Library.

## Global Constraints

- Preserve `Hey, Jarvis`, `Ready.`, the existing auto-run toggles, and Shift+Tab.
- No cloud calls or new dependencies.
- Preserve protected Prompt 14 and Deepgram work.

---

### Task 1: Unified send-mode timing

**Files:** `voiceConversation.ts`, `voiceConversation.test.ts`, `VoiceModal.tsx`, `VoiceModal.turn.test.tsx`

- [ ] Write failing tests proving phrase mode returns no timeout and pause mode clamps one duration to 1–60 seconds.
- [ ] Run the focused tests and confirm RED.
- [ ] Update the pure timeout policy and its single runtime call site.
- [ ] Run focused conversation/turn tests and confirm GREEN.

### Task 2: Voice settings controls

**Files:** `Voice.tsx`, `Voice.test.tsx`

- [ ] Write failing UI tests proving phrase mode hides timing and pause mode exposes exactly one 1–60 second control with mode-aware copy.
- [ ] Run the focused test and confirm RED.
- [ ] Remove the duplicate timeout UI and update the remaining label/helper text.
- [ ] Run the focused test and confirm GREEN.

### Task 3: Real microphone test

**Files:** `microphoneTest.ts`, `microphoneTest.test.ts`, `MicrophoneTestPanel.tsx`, `MicrophoneTestPanel.test.tsx`, `Voice.tsx`

- [ ] Write failing tests for denied permission, no device, device switching, silence, background noise, live level, playback, pass/fail, and cleanup.
- [ ] Run the focused tests and confirm RED.
- [ ] Implement bounded capture, classification, cleanup, device selection, permission display, level meter, and local playback.
- [ ] Run focused tests and confirm GREEN.

### Task 4: Verification

- [ ] Run wake-word, VoiceService, turn, settings, hotkey, auth, and production-build checks.
- [ ] Inspect the packaged runtime contract and record OS-policy/manual-hardware limitations honestly.
