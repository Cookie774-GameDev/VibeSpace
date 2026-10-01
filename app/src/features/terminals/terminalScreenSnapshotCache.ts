import {
  MAX_TERMINAL_SNAPSHOT_BYTES,
  MAX_TERMINAL_SNAPSHOT_LINES,
  type TerminalSnapshotPayload,
} from './terminalSnapshot';
import { sanitizePersistedTerminalText } from './terminalContentSanitizer';

const MAX_CACHED_TERMINAL_SCREENS = 24;

export interface TerminalScreenSnapshotIdentity {
  accountId: string;
  projectId: string | null;
  paneId: string;
  sessionId: string;
}

interface CachedTerminalScreen {
  identity: TerminalScreenSnapshotIdentity;
  text: string;
}

export interface TerminalScreenSnapshotLease {
  readonly key: string;
  readonly owner: symbol;
}

const screens = new Map<string, CachedTerminalScreen>();
const owners = new Map<string, { identity: TerminalScreenSnapshotIdentity; owner: symbol }>();

function normalizedIdentity(
  identity: TerminalScreenSnapshotIdentity,
): TerminalScreenSnapshotIdentity | null {
  const accountId = identity.accountId.trim();
  const paneId = identity.paneId.trim();
  const sessionId = identity.sessionId.trim();
  if (!accountId || !paneId || !sessionId) return null;
  return {
    accountId,
    projectId: identity.projectId?.trim() || null,
    paneId,
    sessionId,
  };
}

function identityKey(identity: TerminalScreenSnapshotIdentity): string {
  return JSON.stringify([
    identity.accountId,
    identity.projectId,
    identity.paneId,
    identity.sessionId,
  ]);
}

function clearConflictingScreens(identity: TerminalScreenSnapshotIdentity): void {
  for (const [key, entry] of screens) {
    if (
      entry.identity.accountId === identity.accountId &&
      entry.identity.projectId === identity.projectId &&
      entry.identity.paneId === identity.paneId &&
      entry.identity.sessionId !== identity.sessionId
    ) {
      screens.delete(key);
      owners.delete(key);
    }
  }
  for (const [key, entry] of owners) {
    if (
      entry.identity.accountId === identity.accountId &&
      entry.identity.projectId === identity.projectId &&
      entry.identity.paneId === identity.paneId &&
      entry.identity.sessionId !== identity.sessionId
    ) {
      owners.delete(key);
    }
  }
}

function boundedScreenText(text: string): string {
  const safe = sanitizePersistedTerminalText(text, {
    maxBytes: MAX_TERMINAL_SNAPSHOT_BYTES,
    maxLines: MAX_TERMINAL_SNAPSHOT_LINES,
  }).text;
  return safe.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').join('\r\n');
}

export function captureTerminalScreenSnapshot(
  identityInput: TerminalScreenSnapshotIdentity,
  snapshot: TerminalSnapshotPayload,
  lease?: TerminalScreenSnapshotLease | null,
): boolean {
  const identity = normalizedIdentity(identityInput);
  const key = identity ? identityKey(identity) : '';
  if (
    !identity ||
    (lease != null && (lease.key !== key || owners.get(key)?.owner !== lease.owner)) ||
    snapshot.projectId !== identity.projectId ||
    snapshot.paneId !== identity.paneId ||
    snapshot.interactive
  ) {
    return false;
  }
  clearConflictingScreens(identity);
  screens.delete(key);
  screens.set(key, { identity, text: boundedScreenText(snapshot.text) });
  while (screens.size > MAX_CACHED_TERMINAL_SCREENS) {
    const oldest = screens.keys().next().value;
    if (typeof oldest !== 'string') break;
    screens.delete(oldest);
  }
  return true;
}

export function claimTerminalScreenSnapshotLease(
  identityInput: TerminalScreenSnapshotIdentity,
): TerminalScreenSnapshotLease | null {
  const identity = normalizedIdentity(identityInput);
  if (!identity) return null;
  clearConflictingScreens(identity);
  const key = identityKey(identity);
  const owner = Symbol('terminal-screen-owner');
  owners.delete(key);
  owners.set(key, { identity, owner });
  while (owners.size > MAX_CACHED_TERMINAL_SCREENS) {
    const oldest = owners.keys().next().value;
    if (typeof oldest !== 'string') break;
    owners.delete(oldest);
    screens.delete(oldest);
  }
  return { key, owner };
}

export function readTerminalScreenSnapshot(identityInput: TerminalScreenSnapshotIdentity): string {
  const identity = normalizedIdentity(identityInput);
  if (!identity) return '';
  return screens.get(identityKey(identity))?.text ?? '';
}

export function clearTerminalScreenSnapshot(identityInput: TerminalScreenSnapshotIdentity): void {
  const identity = normalizedIdentity(identityInput);
  if (!identity) return;
  const key = identityKey(identity);
  screens.delete(key);
  owners.delete(key);
}

export function clearTerminalScreenSnapshotsOutsideAccount(accountIdInput: string): void {
  const accountId = accountIdInput.trim();
  for (const [key, entry] of screens) {
    if (!accountId || entry.identity.accountId !== accountId) {
      screens.delete(key);
      owners.delete(key);
    }
  }
  for (const [key, entry] of owners) {
    if (!accountId || entry.identity.accountId !== accountId) {
      owners.delete(key);
    }
  }
}

export function _resetTerminalScreenSnapshotCacheForTests(): void {
  screens.clear();
  owners.clear();
}
