import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserChatWorkspaceGrantStore,
  grantBrowserChatWorkspace,
  revokeBrowserChatWorkspace,
} from './workspaceGrant';

describe('Browser Chat workspace grant', () => {
  beforeEach(() => revokeBrowserChatWorkspace());

  it('creates one read-only, session-only grant for an explicit project root', () => {
    const grant = grantBrowserChatWorkspace({
      accountId: 'account-1',
      projectId: 'project-1',
      root: 'C:\\Users\\viper\\Projects\\Safe',
      displayName: 'Safe',
    });

    expect(grant).toMatchObject({
      accountId: 'account-1',
      projectId: 'project-1',
      canonicalRoot: 'C:\\Users\\viper\\Projects\\Safe',
      displayName: 'Safe',
      readAllowed: true,
      createAllowed: false,
      modifyAllowed: false,
      deleteAllowed: false,
      terminalAllowed: false,
      secretPolicy: 'block',
    });
    expect(browserChatWorkspaceGrantStore.getSnapshot()).toEqual(grant);
  });

  it.each([
    'C:\\',
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Users\\viper\\.ssh',
    'C:\\Users\\viper\\AppData\\Local\\Google\\Chrome\\User Data',
    '\\\\server\\share',
  ])('rejects a sensitive or overbroad root: %s', (root) => {
    expect(() =>
      grantBrowserChatWorkspace({
        accountId: 'account-1',
        projectId: 'project-1',
        root,
        displayName: 'Unsafe',
      }),
    ).toThrow(/cannot be granted/i);
  });

  it('notifies subscribers on grant and revoke without writing persistent storage', () => {
    const listener = vi.fn();
    const unsubscribe = browserChatWorkspaceGrantStore.subscribe(listener);

    grantBrowserChatWorkspace({
      accountId: 'account-1',
      projectId: 'project-1',
      root: 'C:\\Users\\viper\\Projects\\Safe',
      displayName: 'Safe',
    });
    revokeBrowserChatWorkspace();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(browserChatWorkspaceGrantStore.getSnapshot()).toBeNull();
    unsubscribe();
  });
});
