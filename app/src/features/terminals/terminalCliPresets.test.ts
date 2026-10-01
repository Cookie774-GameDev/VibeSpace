import { describe, expect, it } from 'vitest';
import {
  TERMINAL_CLI_PRESETS,
  getTerminalCliPreset,
} from './terminalCliPresets';

const EXPECTED_PRESETS = [
  ['claude', 'Claude Code', 'claude'],
  ['codex', 'Codex CLI', 'codex'],
  ['opencode', 'OpenCode', 'opencode'],
  ['grok', 'Grok Build', 'grok'],
  ['gemini', 'Gemini CLI', 'gemini'],
  ['copilot', 'GitHub Copilot CLI', 'copilot'],
  ['aider', 'Aider', 'aider'],
  ['qwen', 'Qwen Code', 'qwen'],
  ['kiro', 'Kiro CLI', 'kiro-cli'],
] as const;

describe('terminal CLI preset registry', () => {
  it('defines the complete stable code-owned registry in display order', () => {
    expect(
      TERMINAL_CLI_PRESETS.map(({ id, displayName, executable }) => [
        id,
        displayName,
        executable,
      ]),
    ).toEqual(EXPECTED_PRESETS);
    expect(Object.isFrozen(TERMINAL_CLI_PRESETS)).toBe(true);
  });

  it('uses inert interactive startup metadata and official HTTPS documentation', () => {
    for (const preset of TERMINAL_CLI_PRESETS) {
      expect(preset.executable).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(preset.startupArgv).toEqual([preset.executable]);
      expect(preset.startupText).toBe(preset.executable);
      expect(preset.helpUrl).toMatch(/^https:\/\//);
      expect(preset.installUrl).toMatch(/^https:\/\//);
      expect(preset.capabilities).toEqual({
        interactive: true,
        headless: true,
      });
      expect(Object.isFrozen(preset)).toBe(true);
      expect(Object.isFrozen(preset.startupArgv)).toBe(true);
      expect(Object.isFrozen(preset.capabilities)).toBe(true);
    }
  });

  it('looks up known IDs without synthesizing unknown presets', () => {
    expect(getTerminalCliPreset('codex')?.executable).toBe('codex');
    expect(getTerminalCliPreset('not-a-preset')).toBeNull();
  });
});
