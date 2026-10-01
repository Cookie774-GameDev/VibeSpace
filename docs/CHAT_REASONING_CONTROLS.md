# Chat reasoning controls

VibeSpace exposes two keyboard-first chat commands:

- `/effort` changes only the reasoning effort for the currently selected single model.
- `/mode` selects **Token Saver**, **Normal**, or **Token Final Boss** without changing the model.

Effort choices are capability-driven. The picker shows only levels that the exact
provider/model transport can send safely. When a stored choice is unavailable after a
model or provider switch, VibeSpace snaps it to the closest supported level; models such
as GPT-4 and Qwen that do not expose a verified adjustable effort show no fabricated
control.

The effective setting is resolved again after automatic model routing, then serialized
through the provider's real request schema. Codex receives
`model_reasoning_effort`, OpenAI/Groq/xAI receive `reasoning_effort`, Anthropic receives
`output_config.effort`, and Gemini receives `generationConfig.thinkingConfig.thinkingLevel`.
All provider-option values are allowlisted before dispatch.

Mode behavior implemented now:

- **Token Saver**: lowest supported native reasoning plus a compact 2,048-token output ceiling.
- **Normal**: provider-default/adaptive reasoning and the normal output ceiling.
- **Token Final Boss**: highest verified reasoning level supported by the selected model.

The broader future mode contract—retrieval breadth, memory selection, structural
compression, planning, critique, and verification policy—is intentionally not simulated
in this change. The saved mode is ready for that backend orchestration while today's UI
truthfully controls only the reasoning and output behavior that is wired end to end.
