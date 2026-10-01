import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetTerminalScreenSnapshotCacheForTests,
  captureTerminalScreenSnapshot,
  claimTerminalScreenSnapshotLease,
  readTerminalScreenSnapshot,
  clearTerminalScreenSnapshotsOutsideAccount,
} from './terminalScreenSnapshotCache';

const identity = {
  accountId: 'account-a',
  projectId: 'project-a',
  paneId: 'pane-a',
  sessionId: 'session-a',
};

describe('terminal screen snapshot cache', () => {
  beforeEach(() => _resetTerminalScreenSnapshotCacheForTests());

  it('returns only the exact sanitized rendered screen without compounding repeated reads', () => {
    captureTerminalScreenSnapshot(identity, {
      schemaVersion: 1,
      projectId: 'project-a',
      paneId: 'pane-a',
      text: 'PS C:\\repo> echo MARK\nMARK\nPS C:\\repo> \u001b[31m',
      rows: 30,
      cols: 100,
      updatedAt: 1,
      command: 'powershell.exe',
      interactive: false,
    });

    const expected = 'PS C:\\repo> echo MARK\r\nMARK\r\nPS C:\\repo> ';
    expect(readTerminalScreenSnapshot(identity)).toBe(expected);
    expect(readTerminalScreenSnapshot(identity)).toBe(expected);
  });

  it('rejects account, project, and pane mismatches and clears a replaced session', () => {
    const snapshot = {
      schemaVersion: 1 as const,
      projectId: 'project-a',
      paneId: 'pane-a',
      text: 'one prompt',
      rows: 30,
      cols: 100,
      updatedAt: 1,
      command: 'powershell.exe',
      interactive: false,
    };
    captureTerminalScreenSnapshot(identity, snapshot);

    expect(readTerminalScreenSnapshot({ ...identity, accountId: 'account-b' })).toBe('');
    expect(readTerminalScreenSnapshot(identity)).toBe('one prompt');

    captureTerminalScreenSnapshot(identity, snapshot);
    captureTerminalScreenSnapshot(
      { ...identity, sessionId: 'session-b' },
      { ...snapshot, text: 'replacement screen' },
    );
    expect(readTerminalScreenSnapshot({ ...identity, sessionId: 'session-b' })).toBe(
      'replacement screen',
    );
    expect(readTerminalScreenSnapshot(identity)).toBe('');

    expect(
      readTerminalScreenSnapshot({ ...identity, sessionId: 'session-b', projectId: 'project-b' }),
    ).toBe('');
  });

  it('clears cached screens when the current account changes or signs out', () => {
    const snapshot = {
      schemaVersion: 1 as const,
      projectId: 'project-a',
      paneId: 'pane-a',
      text: 'account-owned screen',
      rows: 30,
      cols: 100,
      updatedAt: 1,
      command: 'powershell.exe',
      interactive: false,
    };
    captureTerminalScreenSnapshot(identity, snapshot);

    clearTerminalScreenSnapshotsOutsideAccount('account-b');
    expect(readTerminalScreenSnapshot(identity)).toBe('');

    captureTerminalScreenSnapshot(identity, snapshot);
    clearTerminalScreenSnapshotsOutsideAccount('');
    expect(readTerminalScreenSnapshot(identity)).toBe('');
  });

  it('rejects a delayed capture after a later mount claims the same exact identity', () => {
    const snapshot = {
      schemaVersion: 1 as const,
      projectId: 'project-a',
      paneId: 'pane-a',
      text: 'old renderer',
      rows: 30,
      cols: 100,
      updatedAt: 1,
      command: 'powershell.exe',
      interactive: false,
    };
    const oldLease = claimTerminalScreenSnapshotLease(identity);
    const laterLease = claimTerminalScreenSnapshotLease(identity);

    expect(captureTerminalScreenSnapshot(identity, snapshot, oldLease)).toBe(false);
    expect(readTerminalScreenSnapshot(identity)).toBe('');
    expect(
      captureTerminalScreenSnapshot(identity, { ...snapshot, text: 'later renderer' }, laterLease),
    ).toBe(true);
    expect(readTerminalScreenSnapshot(identity)).toBe('later renderer');
  });
});
