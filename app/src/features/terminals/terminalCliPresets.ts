export const TERMINAL_CLI_PRESET_IDS = [
  'claude',
  'codex',
  'opencode',
  'grok',
  'gemini',
  'copilot',
  'aider',
  'qwen',
  'kiro',
] as const;

export type TerminalCliPresetId = (typeof TERMINAL_CLI_PRESET_IDS)[number];

export interface TerminalCliPreset {
  id: TerminalCliPresetId;
  displayName: string;
  executable: string;
  startupArgv: readonly string[];
  startupText: string;
  installUrl: string;
  helpUrl: string;
  capabilities: Readonly<{
    interactive: boolean;
    headless: boolean;
  }>;
}

function preset(
  id: TerminalCliPresetId,
  displayName: string,
  executable: string,
  documentationUrl: string,
): TerminalCliPreset {
  return Object.freeze({
    id,
    displayName,
    executable,
    startupArgv: Object.freeze([executable]),
    startupText: executable,
    installUrl: documentationUrl,
    helpUrl: documentationUrl,
    capabilities: Object.freeze({ interactive: true, headless: true }),
  });
}

/**
 * Code-owned interactive CLI metadata verified against each vendor's official
 * documentation. These are inert launch names and links: this registry never
 * executes a probe, downloads an installer, or stores credentials.
 */
export const TERMINAL_CLI_PRESETS: readonly TerminalCliPreset[] = Object.freeze([
  preset('claude', 'Claude Code', 'claude', 'https://docs.anthropic.com/en/docs/claude-code/setup'),
  preset('codex', 'Codex CLI', 'codex', 'https://developers.openai.com/codex/cli/'),
  preset('opencode', 'OpenCode', 'opencode', 'https://opencode.ai/docs/cli/'),
  preset('grok', 'Grok Build', 'grok', 'https://docs.x.ai/build/overview'),
  preset('gemini', 'Gemini CLI', 'gemini', 'https://github.com/google-gemini/gemini-cli'),
  preset(
    'copilot',
    'GitHub Copilot CLI',
    'copilot',
    'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
  ),
  preset('aider', 'Aider', 'aider', 'https://aider.chat/docs/install.html'),
  preset('qwen', 'Qwen Code', 'qwen', 'https://github.com/QwenLM/qwen-code'),
  preset('kiro', 'Kiro CLI', 'kiro-cli', 'https://kiro.dev/docs/cli/'),
]);

const PRESET_BY_ID = new Map<TerminalCliPresetId, TerminalCliPreset>(
  TERMINAL_CLI_PRESETS.map((item) => [item.id, item]),
);

export function getTerminalCliPreset(id: string): TerminalCliPreset | null {
  return PRESET_BY_ID.get(id as TerminalCliPresetId) ?? null;
}
