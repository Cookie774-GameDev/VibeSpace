/**
 * V2 — Jarvis Assistant.
 *
 * A natural-language command bar that runs LOCALLY with no remote AI call.
 * Users type things like "create project tiger" or "open 4 terminals" and
 * the deterministic parser dispatches to the right repo / store action.
 *
 * Render path:
 *   - Mod+J hotkey opens the dialog (registered in App.tsx GlobalHotkeysHost)
 *   - Topbar Sparkles button also opens it
 *   - The dialog reads `useUIStore.assistantOpen`
 */
export { AssistantBar } from './AssistantBar';
export { parseAssistantInput } from './parse';
export { executeIntent } from './execute';
export type { AssistantIntent, AssistantResult } from './intents';
