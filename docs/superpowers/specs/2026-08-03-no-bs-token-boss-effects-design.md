# NO BS and Token Boss Effects Design

## Scope

Integrate the two owner-supplied live references without importing their demo shells:

- `NO BS ANIMATION-SENT/index.html`
- `CHAT TOKENBOSS MODE-SENT/index(16).html`

The work is limited to the Agents NO BS activation feedback and the active Chat `/token boss`
cinematic. Existing prompt directives, model selection, reasoning modes, billing, usage, quotas,
navigation, themes, and chat delivery remain authoritative and unchanged.

## NO BS

The existing NO BS checkbox remains the source of truth. Enabling it immediately applies the
existing `## NO BS` prompt section, then opens one isolated cinematic:

1. A user card types `1 + 2 = 5`.
2. An assistant card enters with `ACTUALLY`.
3. The verbose correction appears word by word with a short progress line.
4. The scene impacts into `NO BS / ENABLED`.

The cinematic is scoped to its own fixed overlay, uses no global selectors or whole-root filter,
supports Escape/click-to-skip, restores focus to the checkbox, and collapses to a brief accessible
confirmation under reduced motion. Disabling NO BS remains immediate and does not replay the
effect.

## Token Boss

The visible slash command is exactly:

- Label: `Token Boss`
- Command: `/token boss`
- Description: `Smash the active model provider token`

`/token final boss` remains a hidden compatibility alias. Activating either command reads the
current chat model selection at that moment and resolves it to one of the 15 reference provider
families. Codex-specific identifiers are resolved before generic OpenAI/ChatGPT identifiers.

The command text is consumed and is never sent as a chat message. A singleton canvas overlay is
mounted inside the active chat viewport. It is pointer-inert, DPR-safe, bounded to the chat route,
and cleans up RAF, audio, event listeners, and focus on finish, skip, unmount, route change, or
document hiding.

The renderer retains the reference's physical minted provider token, pixel boss, hammer
wind-up/contact, cracks, fragments, sparks, dust, shockwave, usage HUD, hit stop, shake, and
letterbox staging. The displayed 100-to-0 meter is explicitly cinematic and never mutates real
usage, billing, entitlement, or quota state.

## Provider Resolution

The pure resolver accepts provider, connection, model, and runtime identifiers and resolves these
families:

`codex`, `gemini`, `chatgpt`, `claude`, `grok`, `deepseek`, `qwen`, `llama`, `kimi`, `mistral`,
`perplexity`, `cohere`, `minimax`, `nemotron`, `ollama`.

Ollama is selected only from an explicit local/Ollama runtime signal. Unknown contexts fail
gracefully with a non-blocking message and do not start a misleading animation.

## Verification

- Pure provider-resolution tests cover all 15 families, aliases, unknowns, and Codex precedence.
- Slash-command tests prove one visible command, hidden alias resolution, and exact copy.
- Composer tests prove current selection extraction and command consumption.
- Component tests prove singleton lifecycle, skip/finish cleanup, focus restoration, reduced
  motion, and no real usage mutation.
- Agent tests prove the existing prompt directive still persists and only Off-to-On launches the
  cinematic.
