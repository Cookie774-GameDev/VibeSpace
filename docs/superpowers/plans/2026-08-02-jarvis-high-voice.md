# Jarvis High Voice Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Jarvis High the default offline voice, retain only Jarvis and Friday personas, provide an immediate bundled exact-script preview, and preserve a clearly labeled operating-system fallback.

**Architecture:** Replace the Kokoro-specific default path with a checksum-pinned Piper/Jarvis model contract and a native Tauri Piper provider. Keep downloads inside the existing local model lifecycle, route Friday and failures to operating-system speech, and package a short Piper-generated MP3 through the existing Vite public-asset path so preview never needs a model download or cloud request.

**Tech Stack:** React, TypeScript, Zustand persistence, Vitest, Tauri 2, Rust, piper-rs, Vite static assets, Playwright/manual app verification.

---

### Task 1: Migrate the persisted voice contract and persona catalog

**Files:**
- Modify: `app/src/types/common.ts`
- Modify: `app/src/store/authStore.ts`
- Modify: `app/src/store/__tests__/authStore.test.ts`
- Modify: `app/src/features/onboarding/steps/personas-data.ts`
- Modify: `app/src/features/voice/personas.ts`
- Modify: `app/src/features/agents/personas.ts`
- Modify: `app/src/features/voice/speechSynthesis.ts`

**Step 1: Write failing migration and catalog tests**

Add focused assertions that Kokoro settings migrate to Jarvis, removed personas migrate to Jarvis, the only selectable personas are Jarvis and Friday, and the shared preview script is exactly `Hi, what should we get to work on?`.

**Step 2: Run the focused tests to verify failure**

Run: `npm --prefix app run test -- --run src/store/__tests__/authStore.test.ts src/features/voice`

Expected: FAIL because the current types, migration, catalogs, and preview copy still expose Kokoro and retired personas.

**Step 3: Implement the minimal contract migration**

Change the voice engine union/default from `kokoro` to `jarvis`, bump the persisted auth schema, migrate stored `kokoro` values to `jarvis`, and normalize removed personas to `jarvis`. Reduce product persona catalogs and voice selection mappings to Jarvis and Friday without changing unrelated agent-role personas.

**Step 4: Run focused tests**

Run: `npm --prefix app run test -- --run src/store/__tests__/authStore.test.ts src/features/voice`

Expected: PASS.

### Task 2: Define and verify the Jarvis High model lifecycle

**Files:**
- Modify: `app/src/features/voice/modelManager.ts`
- Modify: `app/src/features/voice/__tests__/modelManager.test.ts`

**Step 1: Download upstream metadata artifacts to a bounded temporary directory**

Fetch only `jarvis-high.onnx` and `jarvis-high.onnx.json` from the official Hugging Face repository. Record exact byte sizes and SHA-256 digests; reject any mismatch with the official model LFS OID.

**Step 2: Write failing manifest/lifecycle tests**

Assert the manifest identifies Jarvis High/Piper, reports exact artifact bytes, uses checksum-pinned official URLs, installs to the Jarvis model directory, and does not silently replace the authoritative manifest with remote configuration.

**Step 3: Run the model-manager test to verify failure**

Run: `npm --prefix app run test -- --run src/features/voice/__tests__/modelManager.test.ts`

Expected: FAIL against the Kokoro manifest and commands.

**Step 4: Implement the Jarvis model manager**

Replace Kokoro-specific manifest/status/download command use with Jarvis equivalents. Preserve progress, cancellation, retry, local deletion, first-run bootstrap, and update-safe reuse of valid files. Derive displayed size from manifest bytes.

**Step 5: Run the model-manager test**

Run: `npm --prefix app run test -- --run src/features/voice/__tests__/modelManager.test.ts`

Expected: PASS.

### Task 3: Build and package the exact-script offline preview

**Files:**
- Add: `app/public/voice/jarvis-high-preview.mp3`
- Modify: `app/src/features/voice/voiceRouter.ts`
- Modify: `app/src/features/voice/__tests__/voiceRouter.test.ts`

**Step 1: Generate the preview from the verified Jarvis High model**

Use the official Piper executable in a temporary directory with the verified model/config and the exact input `Hi, what should we get to work on?`; encode the resulting short WAV as MP3. Do not ship the generator or downloaded model in the frontend bundle.

**Step 2: Verify the asset**

Run `ffprobe` to confirm a valid short MP3 with audio duration and no network dependency. Record its byte size and SHA-256.

**Step 3: Write a failing immediate-preview test**

Assert Jarvis preview plays `/voice/jarvis-high-preview.mp3` without invoking model download or cloud synthesis, while Friday preview uses operating-system speech with the exact same script.

**Step 4: Implement preview routing and run tests**

Run: `npm --prefix app run test -- --run src/features/voice/__tests__/voiceRouter.test.ts`

Expected: PASS.

### Task 4: Replace the native Kokoro runtime with Piper/Jarvis High

**Files:**
- Add: `app/src-tauri/src/jarvis_voice.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/Cargo.lock`

**Step 1: Add focused Rust unit tests**

Cover model-path validation, manifest checksum/size validation, install status, interrupted-download cleanup, and PCM/WAV output construction where practical without network access.

**Step 2: Run the focused native test to verify failure**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml jarvis_voice`

Expected: FAIL until the Jarvis module and commands exist.

**Step 3: Implement the native provider**

Add Jarvis-specific status/download/cancel/delete/synthesize commands backed by Piper. Download only the ONNX and JSON artifacts, verify size and SHA-256 before atomic install, reuse valid existing files across updates, and return local PCM/WAV bytes. Keep the old Kokoro source unregistered and do not delete legacy user data.

**Step 4: Register commands and dependency feature**

Narrowly update the Tauri command table and Cargo dependencies, preserving all unrelated concurrent edits.

**Step 5: Run focused Rust verification**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml jarvis_voice`

Expected: PASS, or document the exact host policy/toolchain blocker with static verification evidence.

### Task 5: Route normal speech, streaming, offline fallback, and migration

**Files:**
- Add: `app/src/features/voice/providers/jarvisHighLocal.ts`
- Modify: `app/src/features/voice/voiceRouter.ts`
- Modify: `app/src/features/voice/streamingVoice.ts`
- Modify: `app/src/features/voice/__tests__/voiceRouter.test.ts`
- Modify: `app/src/features/voice/__tests__/streamingVoice.test.ts`
- Modify: `app/src/App.tsx`

**Step 1: Add failing routing tests**

Assert Jarvis is the default local engine, normal Jarvis speech invokes native Piper, Friday uses OS speech, native/model failure falls back locally, Deepgram remains explicit opt-in, and startup bootstraps Jarvis without blocking app launch.

**Step 2: Implement the provider and route changes**

Replace Kokoro provider construction with Jarvis High, preserve cancellation/streaming behavior, make fallback status explicit, and narrowly switch the existing startup import to the Jarvis bootstrap.

**Step 3: Run focused routing tests**

Run: `npm --prefix app run test -- --run src/features/voice/__tests__/voiceRouter.test.ts src/features/voice/__tests__/streamingVoice.test.ts`

Expected: PASS.

### Task 6: Update Settings → Voice without unrelated redesign

**Files:**
- Modify: `app/src/features/settings/Voice.tsx`
- Modify: `app/src/features/settings/__tests__/Voice.test.tsx`

**Step 1: Add failing UI assertions**

Assert Jarvis High is labeled default, the exact verified size is rendered from the model manifest, provider/model credit links to the official source, operating-system speech is labeled fallback, only Jarvis and Friday personas appear, and model loading/error/ready controls remain functional.

**Step 2: Implement the narrow UI changes**

Update labels, copy, statuses, card selection, attribution, and persona controls. Preserve layout and unrelated settings behavior.

**Step 3: Run the focused UI test**

Run: `npm --prefix app run test -- --run src/features/settings/__tests__/Voice.test.tsx`

Expected: PASS.

### Task 7: Verify installation, update, offline, fallback, and real UI flow

**Files:**
- Verify only unless a directly scoped defect is found.

**Step 1: Run scoped automated verification**

Run:
- `npm --prefix app run typecheck`
- `npm --prefix app run test -- --run src/store/__tests__/authStore.test.ts src/features/voice src/features/settings/__tests__/Voice.test.tsx`
- `cargo check --manifest-path app/src-tauri/Cargo.toml`
- `cargo test --manifest-path app/src-tauri/Cargo.toml jarvis_voice`

**Step 2: Verify packaging artifacts**

Build the frontend/Tauri bundle using the repository-supported focused command and inspect output to confirm the MP3 is included while the 108.91 MiB model is download-managed rather than duplicated into the frontend bundle.

**Step 3: Exercise the real app flow without closing the running app**

Using Playwright or the available live-app control, open Settings → Voice, verify only Jarvis/Friday personas, play the immediate Jarvis preview with network unavailable, inspect Jarvis default/download state and exact size/credit, confirm Friday and forced Jarvis failure use the OS fallback, and capture evidence without terminating the app.

**Step 4: Review the final diff and coordination state**

Confirm only owned task paths changed, preserve all unrelated dirty work, record material changes/tests in the coordination ledger, and report any exact environmental blocker rather than overstating completion.
