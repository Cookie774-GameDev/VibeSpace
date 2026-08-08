import { normalizePortableAbsolutePath } from '@/lib/actions/filePolicy';

export interface BrowserChatWorkspaceGrant {
  readonly id: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly displayName: string;
  readonly readAllowed: true;
  readonly createAllowed: false;
  readonly modifyAllowed: false;
  readonly deleteAllowed: false;
  readonly terminalAllowed: false;
  readonly secretPolicy: 'block';
  readonly createdAt: number;
}

interface GrantInput {
  readonly accountId: string;
  readonly projectId: string;
  readonly root: string;
  readonly displayName: string;
}

const SAFE_ID = /^[A-Za-z0-9_.:@/-]{1,160}$/u;
const BLOCKED_SEGMENTS = [
  '/windows',
  '/program files',
  '/program files (x86)',
  '/programdata',
  '/.ssh',
  '/.gnupg',
  '/.aws',
  '/.azure',
  '/.kube',
  '/appdata/local/google/chrome/user data',
  '/appdata/local/microsoft/edge/user data',
  '/appdata/roaming/mozilla/firefox/profiles',
];

let currentGrant: BrowserChatWorkspaceGrant | null = null;
const listeners = new Set<() => void>();

function isBlockedRoot(root: string): boolean {
  if (root.startsWith('\\\\') || root === '/' || /^[A-Za-z]:\\$/u.test(root)) return true;
  const comparable = root.replace(/\\/gu, '/').toLowerCase();
  return BLOCKED_SEGMENTS.some(
    (segment) => comparable === segment.slice(1) || comparable.endsWith(segment),
  );
}

function grantId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `grant_${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function publish(): void {
  listeners.forEach((listener) => listener());
}

export const browserChatWorkspaceGrantStore = {
  getSnapshot(): BrowserChatWorkspaceGrant | null {
    return currentGrant;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function grantBrowserChatWorkspace(input: GrantInput): BrowserChatWorkspaceGrant {
  const canonicalRoot = normalizePortableAbsolutePath(input.root);
  if (
    !canonicalRoot ||
    isBlockedRoot(canonicalRoot) ||
    !SAFE_ID.test(input.accountId) ||
    !SAFE_ID.test(input.projectId)
  ) {
    throw new Error('This folder cannot be granted to Browser Chat.');
  }
  const displayName = input.displayName.trim().slice(0, 120);
  if (!displayName) throw new Error('This folder cannot be granted to Browser Chat.');
  currentGrant = Object.freeze({
    id: grantId(),
    accountId: input.accountId,
    projectId: input.projectId,
    canonicalRoot,
    displayName,
    readAllowed: true,
    createAllowed: false,
    modifyAllowed: false,
    deleteAllowed: false,
    terminalAllowed: false,
    secretPolicy: 'block',
    createdAt: Date.now(),
  });
  publish();
  return currentGrant;
}

export function revokeBrowserChatWorkspace(): void {
  if (!currentGrant) return;
  currentGrant = null;
  publish();
}
