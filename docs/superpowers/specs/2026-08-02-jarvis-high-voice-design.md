# Jarvis High Voice Design

## Objective

Replace VibeSpace's default Kokoro local voice with the supplied `jgkawell/jarvis`
high-quality Piper model, provide an immediate offline preview, and reduce the
conversational persona contract to Jarvis and Friday.

## Verified source facts

- Source: `https://huggingface.co/jgkawell/jarvis/tree/main/en/en_GB/jarvis/high`
- License declared by the model repository: MIT.
- Model format: Piper 1.0.0 ONNX, single speaker, British English, 22,050 Hz.
- `jarvis-high.onnx`: 114,199,011 bytes (108.91 MiB), SHA-256
  `9791877d9c099fabbf30be2825e011451c39b3431e21e81e866f5b6507e72993`.
- `jarvis-high.onnx.json`: 7,262 bytes.
- Provider sample `speaker_0.mp3`: 190,738 bytes. It is a voice reference, not
  the requested exact-script product preview.

The existing native implementation is Kokoro-specific: it expects Kokoro token
inputs and separate style embeddings. A URL-only model substitution is invalid
and must not be used.

## Architecture

### Jarvis High runtime

Add a dedicated native Jarvis voice module using the MIT-licensed `piper-rs`
runtime and the existing ONNX/WAV stack. The module owns model download,
resumption, checksum verification, repair, status, cached engine initialization,
speech synthesis, and WAV encoding. It exposes `jarvis_voice_*` commands instead
of presenting Piper as Kokoro.

The frontend model manager uses a built-in, checksum-pinned manifest for the
model and JSON configuration. It stores assets in an OS-stable
`VibeSpace/models/jarvis-high` directory. Server manifests may not replace this
launch-critical source silently; changing the model requires a reviewed app
update.

### Installation and updates

The full 108.91 MiB model remains an authenticated-by-checksum first-launch
download rather than inflating every installer. The existing desktop startup
bootstrap runs after both clean installations and updater relaunches. Its
manifest version and distinct model directory make an existing Kokoro install
insufficient, so upgraded users acquire Jarvis High automatically.

Legacy Kokoro files are left untouched. Removing user files is not necessary
for this prompt and would make rollback destructive.

### Immediate offline preview

Generate a short MP3 from the verified Jarvis High model using exactly:

> Hi, what should we get to work on?

Bundle that MP3 under the application's static assets. Jarvis preview plays the
bundled file without waiting for model status and without network access.
Friday preview speaks the same exact line through a locally installed operating
system voice. If local OS speech is unavailable, the UI reports that truthfully
instead of initiating a cloud call.

### Personas and persistence

`PersonaPreset` becomes `jarvis | friday`. Jarvis retains the current default
behavior. Friday receives a concise, capable, warmer system-prompt seed and
local female-voice preferences.

The persisted auth schema increments once. Existing `athena`, `edge`, `watson`,
`hal`, malformed, or missing persona values migrate to `jarvis`. Existing
`kokoro` engine values migrate to `jarvis`. Jarvis remains the default for new
profiles. The two spoken profiles already presented as JARVIS and FRIDAY remain
available; hidden technical voice profiles are not expanded into personas.

### Voice Settings

The default engine card is titled `Jarvis High` and identifies it as the local
neural default. Its detail panel displays the model size derived from the
manifest's exact byte count, credits Jack Kawell and the Hugging Face source,
and exposes download/repair/test status.

Operating-system speech is titled and described as a fallback. Cloud Deepgram
and paid cloud voice behavior remain unchanged. All previews use the exact
requested line.

## Failure behavior

- Missing/corrupt Jarvis assets: resume or repair from the checksum-pinned
  manifest.
- Download unavailable: keep chat usable and fall back to installed OS speech.
- Piper initialization or synthesis failure: clear the cached failed engine and
  use OS speech for that utterance.
- No local OS voice: show a bounded error; never substitute a cloud call.
- Cancelled preview or reply: stop playback and discard stale completion.

## Verification

- Unit tests for exact manifest bytes/checksums, formatting, new model path, and
  migration from every removed persona and the Kokoro engine.
- Native tests for config parsing, checksums, installed status, and real
  exact-script WAV synthesis when verified model assets are present.
- Component tests showing exactly two personas, source credit, verified size,
  Jarvis default, OS fallback labeling, and immediate bundled preview.
- Router tests proving Jarvis preview does not call cloud or wait for download,
  Friday uses local OS speech, and synthesis failure falls back locally.
- Packaging checks proving the preview is in the production bundle and startup
  invokes Jarvis bootstrap after clean install/update relaunch.
- Focused tests, full TypeScript, production Vite build, native checks where
  Windows policy permits, checksum/license scans, and a real offline playback
  flow.

## Scope boundaries

No cloud voice, billing, calling, plugin, unrelated Settings, updater signing,
external deployment, or unrelated native capability changes are included.
