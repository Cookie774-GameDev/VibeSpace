import { normalizePortableAbsolutePath } from '@/lib/actions/filePolicy';
import {
  deserializePermissionProfile,
  serializePermissionProfile,
  type BrowserChatPermissionProfile,
} from './permissionRegistry';

export interface BrowserChatWorkspaceGrant {
  readonly id: string;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly displayName: string;
  readonly readAllowed: true;
  readonly createAllowed: false;
  readonly modifyAllowed: false;
  readonly deleteAllowed: false;
  readonly terminalAllowed: false;
  readonly secretPolicy: 'block';
  readonly permissionProfile: BrowserChatPermissionProfile;
  readonly createdAt: number;
}

interface GrantInput {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly root: string;
  readonly displayName: string;
  readonly permissionProfile?: BrowserChatPermissionProfile;
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
    !SAFE_ID.test(input.workspaceId) ||
    !SAFE_ID.test(input.projectId)
  ) {
    throw new Error('This folder cannot be granted to Browser Chat.');
  }
  const displayName = input.displayName.trim().slice(0, 120);
  if (!displayName) throw new Error('This folder cannot be granted to Browser Chat.');
  const timestamp = Date.now();
  let permissionProfile: BrowserChatPermissionProfile;
  try {
    permissionProfile = input.permissionProfile
      ? deserializePermissionProfile(serializePermissionProfile(input.permissionProfile))
      : {
          version: 1,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          plan: 'read',
          overrides: {},
          updatedAt: timestamp,
        };
  } catch {
    throw new Error('This Browser Chat permission profile is invalid.');
  }
  if (
    permissionProfile.accountId !== input.accountId ||
    permissionProfile.workspaceId !== input.workspaceId
  ) {
    throw new Error('This Browser Chat permission profile scope does not match the project.');
  }
  currentGrant = Object.freeze({
    id: grantId(),
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    canonicalRoot,
    displayName,
    readAllowed: true,
    createAllowed: false,
    modifyAllowed: false,
    deleteAllowed: false,
    terminalAllowed: false,
    secretPolicy: 'block',
    permissionProfile,
    createdAt: timestamp,
  });
  publish();
  return currentGrant;
}

export function revokeBrowserChatWorkspace(): void {
  if (!currentGrant) return;
  currentGrant = null;
  publish();
}

export function updateBrowserChatWorkspacePermissionProfile(
  profile: BrowserChatPermissionProfile,
): BrowserChatWorkspaceGrant {
  if (!currentGrant) throw new Error('Browser Chat workspace grant is missing.');
  let validated: BrowserChatPermissionProfile;
  try {
    validated = deserializePermissionProfile(serializePermissionProfile(profile));
  } catch {
    throw new Error('Browser Chat permission profile is invalid.');
  }
  if (
    validated.accountId !== currentGrant.accountId ||
    validated.workspaceId !== currentGrant.workspaceId
  ) {
    throw new Error('Browser Chat permission profile scope does not match the workspace grant.');
  }
  if (
    serializePermissionProfile(validated) ===
    serializePermissionProfile(currentGrant.permissionProfile)
  ) {
    return currentGrant;
  }
  currentGrant = Object.freeze({
    ...currentGrant,
    permissionProfile: validated,
  });
  publish();
  return currentGrant;
}
