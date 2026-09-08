import { expect, it } from 'vitest';
import {
  registerCaoTerminalEvidence,
  readCaoTerminalEvidence,
  cleanCaoTerminalHistory,
} from './terminalEvidence';
const identity = { accountId: 'account', projectId: 'project', paneId: 'pane', sessionId: 'tty' };
it('reads only the exact account, project, pane and session', () => {
  const release = registerCaoTerminalEvidence(identity, () => 'Tests: 12 passed');
  expect(readCaoTerminalEvidence(identity)).toBe('Tests: 12 passed');
  for (const field of ['accountId', 'projectId', 'paneId', 'sessionId'] as const)
    expect(readCaoTerminalEvidence({ ...identity, [field]: 'other' })).toBeUndefined();
  release();
  expect(readCaoTerminalEvidence(identity)).toBeUndefined();
});
it('an old component cleanup cannot release its replacement', () => {
  const first = registerCaoTerminalEvidence(identity, () => 'old');
  const second = registerCaoTerminalEvidence(identity, () => 'new');
  first();
  expect(readCaoTerminalEvidence(identity)).toBe('new');
  second();
});
it('removes repeated TUI animation while retaining useful output and redacting secrets', () => {
  const result = cleanCaoTerminalHistory(
    'Build complete\n' +
      '■⬝'.repeat(4000) +
      '\n  Tests: 12 passed\napi_key=sk-abcdefghijklmnopqrstuvwxyz123456789',
  );
  expect(result).toContain('Build complete');
  expect(result).toContain('Tests: 12 passed');
  expect(result).not.toContain('abcdefghijklmnopqrstuvwxyz');
  expect(result.length).toBeLessThan(1000);
});
