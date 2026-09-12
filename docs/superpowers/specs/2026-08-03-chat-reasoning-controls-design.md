# Chat Reasoning Controls Design

## Objective

Add two keyboard-first chat commands without changing the selected model:

- `/effort` changes the current chat's reasoning effort using only values the
  selected provider, connection, and model can actually honor.
- `/mode` selects Token Saver, Normal, or Token Final Boss. The first release
  applies the mode's reasoning and bounded output policy. Broader retrieval,
  memory, planning, critique, and verification behavior remains a documented
  future runtime contract rather than simulated behavior.

## Considered approaches

1. Send one universal `reasoning_effort` value to every provider. Rejected
   because provider schemas and model capabilities differ and unsupported
   parameters produce errors.
2. Keep the controls as decorative Composer state. Rejected because `/effort`
   must affect real requests and persist across restarts.
3. Use a provider/model capability resolver with one normalized UI scale,
   per-chat persisted preferences, and transport-specific serialization.
   Selected because it is truthful, testable, and keeps provider differences
   outside the Composer.

## Interaction design

Both commands use the existing slash option picker, including arrow-key
navigation, Enter/Tab selection, Escape dismissal, hover selection, focus
restoration, and the established theme treatment.

`/effort` displays the selected model and only its supported normalized choices.
The UI scale is Minimal, Low, Medium, High, and Ultra. Transport adapters map
those labels to exact provider values. If a saved or mode-selected value is not
supported after a model switch, it snaps to the closest supported value with a
deterministic quality-preserving rule. Models without a verified adjustable
control show a clear unavailable state and receive no fabricated option.

`/mode` displays:

- **Token Saver:** selected model is preserved; lowest supported effort is used
  and output is bounded for faster, lower-cost responses.
- **Normal:** selected model is preserved; the provider default/adaptive effort
  and normal output ceiling are used.
- **Token Final Boss:** selected model is preserved; the highest supported
  effort is used and the normal output ceiling is not reduced.

Typing `/effort <value>` or `/mode <value>` applies the same validated behavior
as the picker. `/effort auto` clears the manual override. Selecting a mode
clears a previous manual override so the mode is authoritative; selecting an
effort afterward creates an explicit override without changing the mode label.

## Capability and transport rules

- OpenAI reasoning models receive the verified Chat Completions
  `reasoning_effort` value. Non-reasoning GPT-4/4o models expose no effort
  control.
- Codex CLI receives a shell-free `-c model_reasoning_effort="..."` argument.
  The prompt remains on stdin and model IDs remain validated.
- Current supported Anthropic models receive `output_config.effort`.
- Gemini thinking models receive
  `generationConfig.thinkingConfig.thinkingLevel`.
- Groq receives `reasoning_effort` only for verified GPT-OSS models. Qwen does
  not expose the normalized adjustable scale in this feature.
- Ollama receives string `think` levels only for GPT-OSS. Qwen and boolean-only
  thinking models remain outside `/effort`.
- xAI receives `reasoning_effort` only for verified models with documented
  effort controls.
- Every other provider/model receives no effort parameter until a verified
  transport contract exists.

Provider options are allowlisted and reconstructed from typed state. Arbitrary
keys or raw user strings never reach a request body or CLI argument.

## State and request flow

Preferences are stored per chat in bounded local storage:

1. The Composer resolves the exact current single-model selection.
2. The picker derives supported values and the resolved value.
3. A selection writes a normalized mode/manual preference for that chat.
4. Send captures an immutable reasoning snapshot in `jarvis:send`.
5. Runtime revalidates the snapshot against the actual routed provider/model.
6. The router forwards only sanitized provider options and output ceiling.
7. The provider or Codex CLI adapter serializes its verified schema.

Automatic model routing re-resolves the policy against the final routed model,
so an option from the original model cannot leak into an incompatible model.

## Failure behavior

- No selected single model: the picker explains that a model must be selected.
- Unsupported model: the user can still choose a mode, but no native effort
  parameter is sent.
- Stale or malformed persisted data: normalize to Normal with no manual
  override.
- Provider/model switch: snap at read/send time; never mutate the model.
- Provider rejects a previously valid upstream value: surface the existing real
  provider error; do not retry with a hidden model or effort change.

## Verification

Focused tests cover capability matrices, snapping, per-chat isolation,
persistence normalization, slash discovery and selection, manual command
parsing, immutable send snapshots, automatic-routing re-resolution, request
body serialization for each supported native provider, Codex CLI argv safety,
unsupported-provider omission, TypeScript, formatting, diff hygiene, and
secret scanning.

## Verified documentation basis

Capability rules were checked on 2026-08-03 against the official OpenAI API,
Claude Platform effort, Gemini thinking, Groq reasoning, xAI reasoning, Ollama
thinking, and installed Codex CLI option documentation. Dynamic upstream
capabilities must be updated through the resolver and its tests rather than
expanded speculatively in UI code.
