import { describe, expect, it } from 'vitest';
import { parseRlmCommand, resolveRlmEnabled, sanitizeRlmState } from './rlmPreference';

describe('RLM preferences', () => {
  it('defaults on and observes chat > workspace > user override order', () => {
    expect(resolveRlmEnabled({})).toBe(true);
    expect(resolveRlmEnabled({ user: false })).toBe(false);
    expect(resolveRlmEnabled({ user: false, workspace: true })).toBe(true);
    expect(resolveRlmEnabled({ user: true, workspace: true, chat: false })).toBe(false);
  });

  it('parses supported commands and leaves unknown text unconsumed', () => {
    expect(parseRlmCommand('/rlm on')).toEqual({ kind: 'set', enabled: true });
    expect(parseRlmCommand('/rlm trace')).toEqual({ kind: 'trace' });
    expect(parseRlmCommand('/rlm infinite')).toBeNull();
    expect(parseRlmCommand('/rlm on extra')).toBeNull();
  });

  it('fails safe when persisted state is malformed', () => {
    expect(sanitizeRlmState({ userDefault: 'yes', chatOverrides: { ok: false, bad: 'x', '\u0000': true } })).toEqual({
      schemaVersion: 1,
      userDefault: true,
      workspaceOverrides: {},
      chatOverrides: { ok: false },
    });
  });
});
