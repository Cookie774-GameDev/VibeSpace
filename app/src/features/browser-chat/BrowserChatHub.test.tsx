import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { browserChatStore } from './browserChatStore';
import { BrowserChatHub, browserChatMcpStatusLabel } from './BrowserChatHub';
import { browserChatSurface } from './providerSurface';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import * as bridge from '@/lib/bridge';
import { getBridgeWorkspaceGrant, setBridgeWorkspaceGrant } from '@/lib/bridge';
import { projectStorageKey, ROOT_PREFIX } from '@/features/files/projectFiles';
import type { ProjectId } from '@/types/common';
import { browserChatWorkspaceGrantStore, revokeBrowserChatWorkspace } from './workspaceGrant';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import {
  createBrowserChatBindingRepository,
  createProviderProjectLinkRepository,
} from './browserChatRepository';
import type { ChatId, WorkspaceId } from '@/types/common';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import type { Chat } from '@/types/chat';
import {
  beginBrowserChatToolCall,
  clearBrowserChatToolActivity,
  finishBrowserChatToolCall,
  publishBrowserChatToolCatalog,
} from './browserChatToolActivity';
import * as outputFeedModule from './browserChatOutputFeed';

const TEST_CONVERSATION_ONE = `conversation-${1}`;

const providerSurfaceHarness = vi.hoisted(() => ({
  navigationUrl: undefined as string | undefined,
  accountProfileKey: undefined as `profile_${string}` | undefined,
  onNavigation: undefined as
    | ((navigation: {
        providerId: 'chatgpt';
        surfaceId: string;
        accountProfileKey: `profile_${string}`;
        url: string;
        timestamp: number;
        kind: 'conversation';
        providerConversationKey: string;
      }) => void)
    | undefined,
}));

const exportImportHarness = vi.hoisted(() => ({
  importExport: vi.fn(),
  readFile: vi.fn(async (file: File) => file.arrayBuffer()),
}));

vi.mock('./chatGptExport', () => ({
  CHATGPT_EXPORT_MAX_ARCHIVE_BYTES: 64 * 1024 * 1024,
  importChatGptExport: exportImportHarness.importExport,
  readBoundedChatGptExportFile: exportImportHarness.readFile,
}));

vi.mock('./BrowserProviderSurface', () => ({
  BrowserProviderSurface: ({
    provider,
    accountProfileKey,
    navigationUrl,
    onNavigation,
  }: {
    provider: { label: string };
    accountProfileKey: `profile_${string}`;
    navigationUrl?: string;
    onNavigation?: typeof providerSurfaceHarness.onNavigation;
  }) => {
    providerSurfaceHarness.navigationUrl = navigationUrl;
    providerSurfaceHarness.accountProfileKey = accountProfileKey;
    providerSurfaceHarness.onNavigation = onNavigation;
    return (
      <div aria-label={`${provider.label} provider surface`}>
        {provider.label} real provider page
      </div>
    );
  },
}));

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockSuccessfulMcpDiscovery() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(
      jsonResponse({
        resource: 'https://vibespace-mcp.fly.dev/mcp',
        authorization_servers: ['https://auth.example/auth/v1'],
        scopes_supported: ['email', 'profile'],
        bearer_methods_supported: ['header'],
        resource_name: 'VibeSpace MCP',
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        issuer: 'https://auth.example/auth/v1',
        authorization_endpoint: 'https://auth.example/auth/v1/authorize',
        token_endpoint: 'https://auth.example/auth/v1/token',
        registration_endpoint: 'https://auth.example/auth/v1/register',
        scopes_supported: ['openid', 'offline_access'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      }),
    );
}

describe('BrowserChatHub', () => {
  let testDatabase: JarvisDexie;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubEnv('VITE_PHONE_JARVIS_CLOUD_URL', 'https://vibespace-mcp.fly.dev');
    providerSurfaceHarness.onNavigation = undefined;
    providerSurfaceHarness.navigationUrl = undefined;
    providerSurfaceHarness.accountProfileKey = undefined;
    localStorage.clear();
    revokeBrowserChatWorkspace();
    setBridgeWorkspaceGrant();
    bridge.resetBrowserChatRelayStatus();
    clearBrowserChatToolActivity();
    useAuthStore.setState({
      workspaceId: 'workspace-1' as WorkspaceId,
      projectId: 'project-1' as ProjectId,
      localUserId: 'account-1',
      cloudSession: {
        user_id: 'account-1',
        email: 'account-1@example.test',
        expires_at: 4_102_444_800,
      },
    });
    browserChatStore.setState({
      engine: 'browser',
      providerId: 'chatgpt',
      chatPreferences: {},
      preferManagedSurface: true,
      providerRuntime: {},
    });
    testDatabase = createJarvisDb(uniqueTestDbName('browser-chat-hub'), TEST_INDEXED_DB);
    await testDatabase.open();
    exportImportHarness.importExport.mockReset();
    exportImportHarness.readFile.mockClear();
    exportImportHarness.importExport.mockResolvedValue({
      importId: 'import-a',
      added: 1,
      updated: 0,
      unchanged: 0,
      reusedImport: false,
    });
  });

  it.each([
    ['disabled', false, 'idle', 'VibeSpace sign-in required'],
    ['disabled', true, 'idle', 'Setup required'],
    ['connecting', true, 'idle', 'Connecting desktop relay'],
    ['reconnecting', true, 'idle', 'Reconnecting desktop relay'],
    ['error', true, 'idle', 'Connection error'],
    ['connected', true, 'idle', 'Desktop connected'],
    ['disabled', true, 'checking', 'Checking secure connection'],
    ['disabled', true, 'waiting', 'Waiting for owner approval'],
  ] as const)(
    'reports relay=%s signedIn=%s setup=%s as %s',
    (relayStatus, signedIn, setupState, expected) => {
      expect(browserChatMcpStatusLabel(relayStatus, signedIn, setupState)).toBe(expected);
    },
  );
  afterEach(async () => {
    cleanup();
    testDatabase.close();
    await testDatabase.delete();
  });

  const updateTestChat = async (id: ChatId, patch: Partial<Chat>): Promise<Chat> => {
    await testDatabase.chats.update(id, patch);
    const row = await testDatabase.chats.get(id);
    if (!row) throw new Error('chat_not_found');
    return row;
  };

  const renderHub = (
    chatId?: string,
    initialSessions?: ComponentProps<typeof BrowserChatHub>['initialSessions'],
    initialProjects?: ComponentProps<typeof BrowserChatHub>['initialProjects'],
    initialOutputFeed?: ComponentProps<typeof BrowserChatHub>['initialOutputFeed'],
    createChat?: ComponentProps<typeof BrowserChatHub>['createChat'],
  ) =>
    render(
      <BrowserChatHub
        chatId={chatId}
        database={testDatabase}
        updateChat={updateTestChat}
        bindingScope={{ accountId: 'account-1', workspaceId: 'workspace-1' }}
        initialSessions={initialSessions}
        initialProjects={initialProjects}
        initialOutputFeed={initialOutputFeed}
        createChat={createChat}
      />,
    );

  it('shows the three provider-owned surfaces with separate page and bridge status', () => {
    renderHub();

    expect(screen.getByRole('tab', { name: 'ChatGPT' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Claude/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Gemini/i })).toBeTruthy();
    expect(screen.getByText(/page status/i)).toBeTruthy();
    expect(screen.getByText(/tool bridge/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /open chatgpt/i })).toBeTruthy();
    expect(screen.queryByText(/sign in or sign up/i)).toBeNull();
    expect(screen.getByText(/not auto-connected/i)).toBeTruthy();
    expect(screen.getByText(/provider subscription and limits still apply/i)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('opens and labels the durable provider-project link for new local sessions', async () => {
    const providerProjectRepository = createProviderProjectLinkRepository(
      testDatabase,
      () => 100,
      () => 'provider-project-link-1',
    );
    await providerProjectRepository.create({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      provider: 'chatgpt',
      providerProjectKey: 'project-linked',
      providerProjectUrl: 'https://chatgpt.com/g/project-linked/project',
    });
    await expect(
      providerProjectRepository.getForProject(
        { accountId: 'account-1', workspaceId: 'workspace-1' },
        'project-1',
        'chatgpt',
      ),
    ).resolves.toMatchObject({
      state: 'linked',
      providerProjectKey: 'project-linked',
      providerProjectUrl: 'https://chatgpt.com/g/project-linked/project',
    });
    const createChat = vi.fn(async () => {
      const chat: Chat = {
        id: 'chat-linked' as ChatId,
        workspace_id: 'workspace-1' as WorkspaceId,
        project_id: 'project-1' as ProjectId,
        title: 'ChatGPT browser chat',
        mode: 'chat',
        active_agent_ids: [],
        pinned: false,
        created_at: 1,
        updated_at: 1,
      };
      await testDatabase.chats.put(chat);
      return chat.id;
    });

    renderHub(undefined, undefined, undefined, undefined, createChat);

    await waitFor(() =>
      expect(providerSurfaceHarness.navigationUrl).toBe(
        'https://chatgpt.com/g/project-linked/project',
      ),
    );
    expect(screen.getByText(/provider project linked/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /new provider chat/i }));
    await waitFor(async () =>
      expect(
        await testDatabase.browser_chat_bindings
          .where('[accountId+workspaceId]')
          .equals(['account-1', 'workspace-1'])
          .first(),
      ).toMatchObject({
        chatId: 'chat-linked',
        projectId: 'project-1',
        providerProjectKey: 'project-linked',
      }),
    );
  });

  it('renders provider, account, authorization, relay, model, and usage states independently', () => {
    bridge.publishBrowserChatRelayStatus('connected');

    renderHub();

    expect(screen.getByText('Provider session')).toBeTruthy();
    expect(screen.getByText('Provider-managed · sign-in state not exposed')).toBeTruthy();
    expect(screen.getByText('VibeSpace account')).toBeTruthy();
    expect(screen.getByText('account-1@example.test')).toBeTruthy();
    expect(screen.getByText('MCP authorization')).toBeTruthy();
    expect(screen.getByText('Unknown · no OAuth authorization evidence')).toBeTruthy();
    expect(screen.getByText('Desktop relay')).toBeTruthy();
    expect(screen.getByText('Provider-controlled · not exposed to VibeSpace')).toBeTruthy();
    expect(screen.getByText('ChatGPT web quota is not exposed to VibeSpace')).toBeTruthy();
    expect(screen.queryByText(/^authorized$/i)).toBeNull();
  });

  it('renders only verified account-project output metadata from the live feed', async () => {
    await testDatabase.jarvis_runs.bulkAdd([
      {
        id: 'run-output',
        account_id: 'account-1',
        workspace_id: 'workspace-1',
        project_id: 'project-1',
        source: 'browser_chat',
        status: 'completed',
        agent_id: 'jarvis',
        identity_version: 1,
        profile_revision_id: 'revision-output',
        model: {
          provider_id: 'local',
          model_id: 'fixture',
          connection_mode: 'local',
          capabilities: {},
          captured_at: 1,
        },
        created_at: 1,
        updated_at: 30,
        completed_at: 30,
      },
      {
        id: 'run-output-foreign',
        account_id: 'account-2',
        workspace_id: 'workspace-1',
        project_id: 'project-1',
        source: 'browser_chat',
        status: 'completed',
        agent_id: 'jarvis',
        identity_version: 1,
        profile_revision_id: 'revision-foreign',
        model: {
          provider_id: 'local',
          model_id: 'fixture',
          connection_mode: 'local',
          capabilities: {},
          captured_at: 1,
        },
        created_at: 1,
        updated_at: 40,
        completed_at: 40,
      },
    ]);
    await testDatabase.jarvis_artifacts.bulkAdd([
      {
        schema_version: 1,
        id: 'artifact-output',
        run_id: 'run-output',
        request_id: 'request-output',
        attempt_number: 1,
        state: 'ready',
        kind: 'code',
        title: 'Generated browser output',
        safe_summary: 'Verified output metadata.',
        source_refs: [],
        created_at: 30,
      },
      {
        schema_version: 1,
        id: 'artifact-output-foreign',
        run_id: 'run-output-foreign',
        request_id: 'request-output-foreign',
        attempt_number: 1,
        state: 'ready',
        kind: 'text',
        title: 'Foreign browser output',
        source_refs: [],
        created_at: 40,
      },
    ]);
    const outputFeed = await outputFeedModule.listBrowserChatOutputFeed({
      database: testDatabase,
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    });
    expect(outputFeed).toMatchObject({
      runs: [{ id: 'run-output', outputs: [{ title: 'Generated browser output' }] }],
    });

    renderHub(undefined, undefined, undefined, outputFeed);

    expect(await screen.findByText('Generated browser output')).toBeTruthy();
    expect(screen.getByText(/browser chat · completed/i)).toBeTruthy();
    expect(screen.queryByText('Foreign browser output')).toBeNull();
    expect(screen.getByRole('button', { name: /open verified outputs in history/i })).toBeTruthy();
  });

  it('imports only an explicitly selected official ChatGPT export ZIP', async () => {
    renderHub();
    const input = screen.getByLabelText('Choose official ChatGPT export ZIP');
    const file = new File([new Uint8Array([1, 2, 3])], 'chatgpt-export.zip', {
      type: 'application/zip',
    });
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(exportImportHarness.importExport).toHaveBeenCalledWith(
        expect.objectContaining({
          database: testDatabase,
          accountId: 'account-1',
          workspaceId: 'workspace-1',
          fileName: 'chatgpt-export.zip',
          archive: expect.any(ArrayBuffer),
          signal: expect.any(AbortSignal),
          onProgress: expect.any(Function),
        }),
      ),
    );
  });

  it('rejects an oversized export before reading it and exposes cancellation while importing', async () => {
    renderHub();
    const input = screen.getByLabelText('Choose official ChatGPT export ZIP');
    const oversized = new File([new Uint8Array([1])], 'oversized.zip', {
      type: 'application/zip',
    });
    Object.defineProperty(oversized, 'size', { value: 64 * 1024 * 1024 + 1 });

    fireEvent.change(input, { target: { files: [oversized] } });
    expect(exportImportHarness.readFile).not.toHaveBeenCalled();
    expect(exportImportHarness.importExport).not.toHaveBeenCalled();

    let finishImport: (() => void) | undefined;
    exportImportHarness.importExport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishImport = () =>
            resolve({
              importId: 'import-1',
              added: 0,
              updated: 0,
              unchanged: 0,
              reusedImport: false,
            });
        }),
    );
    const accepted = new File([new Uint8Array([1, 2, 3])], 'accepted.zip', {
      type: 'application/zip',
    });
    fireEvent.change(input, { target: { files: [accepted] } });
    await waitFor(() => expect(exportImportHarness.importExport).toHaveBeenCalledOnce());
    const signal = exportImportHarness.importExport.mock.calls[0]?.[0]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /cancel chatgpt export import/i }));
    expect(signal.aborted).toBe(true);
    await act(async () => finishImport?.());
  });

  it('keeps Claude and Gemini gated as future providers without scraping remote history', () => {
    renderHub();

    const claude = screen.getByRole('tab', { name: /Claude/i });
    const gemini = screen.getByRole('tab', { name: /Gemini/i });
    expect(claude).toHaveProperty('disabled', true);
    expect(gemini).toHaveProperty('disabled', true);
    fireEvent.click(claude);
    expect(browserChatStore.getState().providerId).toBe('chatgpt');
    expect(screen.getByLabelText('ChatGPT provider surface')).toBeTruthy();
    expect(document.body.textContent).toMatch(/does not.*read provider messages/i);
    expect(document.body.textContent).not.toMatch(/sync remote history/i);
  });

  it('renders durable pinned and provider sessions and persists their local actions', async () => {
    const hideAll = vi.spyOn(browserChatSurface, 'hideAll').mockResolvedValue();
    await testDatabase.projects.bulkPut([
      {
        id: 'project-1' as ProjectId,
        workspace_id: 'workspace-1' as WorkspaceId,
        name: 'Project One',
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'project-2' as ProjectId,
        workspace_id: 'workspace-1' as WorkspaceId,
        name: 'Project Two',
        created_at: 1,
        updated_at: 1,
      },
    ]);
    await testDatabase.chats.bulkPut([
      {
        id: 'chat-pinned' as ChatId,
        workspace_id: 'workspace-1' as WorkspaceId,
        project_id: 'project-1' as ProjectId,
        title: 'Legacy pinned title',
        mode: 'chat',
        active_agent_ids: [],
        pinned: false,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'chat-regular' as ChatId,
        workspace_id: 'workspace-1' as WorkspaceId,
        project_id: 'project-1' as ProjectId,
        title: 'Legacy regular title',
        mode: 'chat',
        active_agent_ids: [],
        created_at: 1,
        updated_at: 1,
      },
    ]);
    let id = 0;
    const repository = createBrowserChatBindingRepository(
      testDatabase,
      () => 100,
      () => `binding-${++id}`,
    );
    const pinned = await repository.create({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      chatId: 'chat-pinned',
      provider: 'chatgpt',
      providerProfileKey: 'browser-chat/chatgpt',
      localTitle: 'Pinned architecture',
      pinned: true,
    });
    const regular = await repository.create({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      chatId: 'chat-regular',
      provider: 'chatgpt',
      providerProfileKey: 'browser-chat/chatgpt',
      localTitle: 'Research notes',
    });
    expect(
      await repository.list({ accountId: 'account-1', workspaceId: 'workspace-1' }),
    ).toHaveLength(2);
    const seededChats = await testDatabase.chats.bulkGet([
      'chat-pinned',
      'chat-regular',
    ] as ChatId[]);
    const seededProjects = await testDatabase.projects
      .where('workspace_id')
      .equals('workspace-1')
      .sortBy('name');
    expect(seededChats).toEqual([
      expect.objectContaining({ id: 'chat-pinned' }),
      expect.objectContaining({ id: 'chat-regular' }),
    ]);
    browserChatStore.getState().setEngine('browser', 'chat-regular');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderHub(
      'chat-regular',
      [
        { binding: pinned, chat: seededChats[0]! },
        { binding: regular, chat: seededChats[1]! },
      ],
      seededProjects,
    );

    expect(screen.getByRole('heading', { name: 'Pinned' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Pinned architecture' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Research notes' })).toBeTruthy();

    providerSurfaceHarness.onNavigation?.({
      providerId: 'chatgpt',
      surfaceId: 'browser-chat-chatgpt',
      accountProfileKey: providerSurfaceHarness.accountProfileKey!,
      url: 'https://chatgpt.com/c/conversation-1',
      timestamp: 101,
      kind: 'conversation',
      providerConversationKey: TEST_CONVERSATION_ONE,
    });
    await waitFor(async () =>
      expect(await testDatabase.browser_chat_bindings.get(regular.id)).toMatchObject({
        providerConversationKey: TEST_CONVERSATION_ONE,
        resumeUrl: 'https://chatgpt.com/c/conversation-1',
        bindingState: 'bound',
        lastOpenedAt: 101,
      }),
    );
    expect(
      (await testDatabase.browser_chat_bindings.get(pinned.id))?.providerConversationKey,
    ).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Unpin Pinned architecture' }));
    await waitFor(async () =>
      expect((await testDatabase.browser_chat_bindings.get(pinned.id))?.pinned).toBe(false),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rename Research notes' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Browser Chat title' }), {
      target: { value: 'Renamed research' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Browser Chat title' }));
    await waitFor(async () => {
      expect((await testDatabase.browser_chat_bindings.get(regular.id))?.localTitle).toBe(
        'Renamed research',
      );
      expect((await testDatabase.chats.get('chat-regular' as ChatId))?.title).toBe(
        'Renamed research',
      );
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Project for Renamed research' }), {
      target: { value: 'project-2' },
    });
    await waitFor(async () => {
      expect((await testDatabase.browser_chat_bindings.get(regular.id))?.projectId).toBe(
        'project-2',
      );
      expect((await testDatabase.chats.get('chat-regular' as ChatId))?.project_id).toBe(
        'project-2',
      );
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Project for Renamed research' }), {
      target: { value: '' },
    });
    await waitFor(async () => {
      expect((await testDatabase.browser_chat_bindings.get(regular.id))?.projectId).toBeUndefined();
      expect((await testDatabase.chats.get('chat-regular' as ChatId))?.project_id).toBeUndefined();
      expect(hideAll).toHaveBeenCalledOnce();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Renamed research' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove Renamed research' }));
    await waitFor(async () =>
      expect(await testDatabase.browser_chat_bindings.get(regular.id)).toBeUndefined(),
    );
    expect(browserChatStore.getState().chatPreferences['chat-regular']?.engine).toBe('native');
  });

  it('renders a 50-session rail with 10 pinned sessions without truncating local actions', () => {
    const sessions = Array.from({ length: 50 }, (_, index) => {
      const chatId = `chat-scale-${index}`;
      const title = `Saved session ${index + 1}`;
      return {
        binding: {
          id: `binding-scale-${index}`,
          accountId: 'account-1',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          chatId,
          provider: 'chatgpt' as const,
          providerProfileKey: 'browser-chat/chatgpt',
          bindingState: 'new' as const,
          localTitle: title,
          pinned: index < 10,
          viewMode: 'vibespace' as const,
          createdAt: index + 1,
          updatedAt: index + 1,
        },
        chat: {
          id: chatId as ChatId,
          workspace_id: 'workspace-1' as WorkspaceId,
          project_id: 'project-1' as ProjectId,
          title,
          mode: 'chat' as const,
          active_agent_ids: [],
          pinned: index < 10,
          created_at: index + 1,
          updated_at: index + 1,
        },
      };
    });

    renderHub('chat-scale-49', sessions);

    expect(screen.getAllByRole('button', { name: /^Open Saved session \d+$/i })).toHaveLength(50);
    expect(screen.getByRole('heading', { name: 'Pinned' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Provider sessions', level: 3 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unpin Saved session 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pin Saved session 50' })).toBeTruthy();
  });

  it('persists Provider and VibeSpace presentation modes without replacing the provider surface', async () => {
    const binding = {
      id: 'binding-presentation-mode',
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      chatId: 'chat-presentation-mode',
      provider: 'chatgpt' as const,
      providerProfileKey: 'browser-chat/chatgpt',
      providerConversationKey: 'presentation-conversation',
      resumeUrl: 'https://chatgpt.com/c/presentation-conversation',
      bindingState: 'bound' as const,
      localTitle: 'Presentation mode chat',
      pinned: false,
      viewMode: 'vibespace' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const chat = {
      id: 'chat-presentation-mode' as ChatId,
      workspace_id: 'workspace-1' as WorkspaceId,
      project_id: 'project-1' as ProjectId,
      title: 'Presentation mode chat',
      mode: 'chat' as const,
      active_agent_ids: [],
      pinned: false,
      created_at: 1,
      updated_at: 1,
    };
    await testDatabase.chats.put(chat);
    await testDatabase.browser_chat_bindings.put(binding);

    renderHub('chat-presentation-mode', [{ binding, chat }]);

    expect(screen.getByLabelText('Browser Chat local sessions')).toBeTruthy();
    expect(screen.getByLabelText('Browser Chat connection inspector')).toBeTruthy();
    const providerSurface = screen.getByLabelText('ChatGPT provider surface');

    fireEvent.click(screen.getByRole('button', { name: 'Provider presentation mode' }));

    await waitFor(async () =>
      expect((await testDatabase.browser_chat_bindings.get(binding.id))?.viewMode).toBe('provider'),
    );
    expect(screen.queryByLabelText('Browser Chat local sessions')).toBeNull();
    expect(screen.queryByLabelText('Browser Chat connection inspector')).toBeNull();
    expect(screen.getByLabelText('ChatGPT provider surface')).toBe(providerSurface);

    fireEvent.click(screen.getByRole('button', { name: 'VibeSpace presentation mode' }));

    await waitFor(async () =>
      expect((await testDatabase.browser_chat_bindings.get(binding.id))?.viewMode).toBe(
        'vibespace',
      ),
    );
    expect(screen.getByLabelText('Browser Chat local sessions')).toBeTruthy();
    expect(screen.getByLabelText('Browser Chat connection inspector')).toBeTruthy();
    expect(screen.getByLabelText('ChatGPT provider surface')).toBe(providerSurface);
  });

  it('shows per-session evidence and opens a validated saved conversation from its action menu', async () => {
    const openExternalNavigation = vi
      .spyOn(browserChatSurface, 'openExternalNavigation')
      .mockResolvedValue();
    publishBrowserChatToolCatalog({
      accountId: 'account-1',
      toolNames: ['fs.read'],
      now: 100,
    });
    beginBrowserChatToolCall({
      accountId: 'account-1',
      callId: 'call_session_running',
      toolName: 'fs.read',
      now: 110,
    });
    browserChatStore.getState().setProviderRuntime('chatgpt', {
      pageStatus: 'ready',
      toolBridgeStatus: 'connected_read_only',
    });
    const title = 'Mapped provider session';
    const session = {
      binding: {
        id: 'binding-session-evidence',
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        chatId: 'chat-session-evidence',
        provider: 'chatgpt' as const,
        providerProfileKey: 'browser-chat/chatgpt',
        providerConversationKey: TEST_CONVERSATION_ONE,
        resumeUrl: 'https://chatgpt.com/c/conversation-1',
        bindingState: 'bound' as const,
        localTitle: title,
        pinned: false,
        viewMode: 'vibespace' as const,
        createdAt: 1,
        updatedAt: 2,
        lastOpenedAt: Date.UTC(2026, 7, 10, 15, 30),
      },
      chat: {
        id: 'chat-session-evidence' as ChatId,
        workspace_id: 'workspace-1' as WorkspaceId,
        project_id: 'project-1' as ProjectId,
        title,
        mode: 'chat' as const,
        active_agent_ids: [],
        pinned: false,
        created_at: 1,
        updated_at: 2,
      },
    };

    renderHub(
      'chat-session-evidence',
      [session],
      [
        {
          id: 'project-1' as ProjectId,
          workspace_id: 'workspace-1' as WorkspaceId,
          name: 'Project Alpha',
          created_at: 1,
          updated_at: 1,
        },
      ],
    );

    expect(screen.getByText(/Project Alpha · Last opened/i)).toBeTruthy();
    expect(screen.getByText(/Active · page ready · fs\.read running/i)).toBeTruthy();
    expect(providerSurfaceHarness.navigationUrl).toBe('https://chatgpt.com/c/conversation-1');
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${title}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: `Open ${title} externally` }));

    await waitFor(() =>
      expect(openExternalNavigation).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'chatgpt' }),
        'https://chatgpt.com/c/conversation-1',
      ),
    );
  });

  it('selects an existing saved row when provider navigation reaches its conversation', async () => {
    let bindingSequence = 0;
    const repository = createBrowserChatBindingRepository(
      testDatabase,
      () => 200,
      () => `binding-navigation-${++bindingSequence}`,
    );
    const chats: Chat[] = [
      {
        id: 'chat-conversation-a' as ChatId,
        workspace_id: 'workspace-1' as WorkspaceId,
        project_id: 'project-1' as ProjectId,
        title: 'Conversation A',
        mode: 'chat',
        active_agent_ids: [],
        pinned: false,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'chat-conversation-b' as ChatId,
        workspace_id: 'workspace-1' as WorkspaceId,
        project_id: 'project-1' as ProjectId,
        title: 'Conversation B',
        mode: 'chat',
        active_agent_ids: [],
        pinned: false,
        created_at: 2,
        updated_at: 2,
      },
    ];
    await testDatabase.chats.bulkPut(chats);
    const bindingA = await repository.create({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      chatId: 'chat-conversation-a',
      provider: 'chatgpt',
      providerProfileKey: 'browser-chat/chatgpt',
      providerConversationKey: 'conversation-a',
      resumeUrl: 'https://chatgpt.com/c/conversation-a',
      bindingState: 'bound',
      localTitle: 'Conversation A',
    });
    const bindingB = await repository.create({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      chatId: 'chat-conversation-b',
      provider: 'chatgpt',
      providerProfileKey: 'browser-chat/chatgpt',
      providerConversationKey: 'conversation-b',
      resumeUrl: 'https://chatgpt.com/c/conversation-b',
      bindingState: 'bound',
      localTitle: 'Conversation B',
    });

    renderHub('chat-conversation-a', [
      { binding: bindingA, chat: chats[0]! },
      { binding: bindingB, chat: chats[1]! },
    ]);
    await act(async () => {
      providerSurfaceHarness.onNavigation?.({
        providerId: 'chatgpt',
        surfaceId: 'browser-chat-chatgpt',
        accountProfileKey: providerSurfaceHarness.accountProfileKey!,
        url: 'https://chatgpt.com/c/conversation-b',
        timestamp: 220,
        kind: 'conversation',
        providerConversationKey: 'conversation-b',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await waitFor(() => expect(useUIStore.getState().activeChatId).toBe('chat-conversation-b'));
    expect(await testDatabase.browser_chat_bindings.get(bindingA.id)).toMatchObject({
      providerConversationKey: 'conversation-a',
      resumeUrl: 'https://chatgpt.com/c/conversation-a',
    });
    expect(await testDatabase.browser_chat_bindings.get(bindingB.id)).toMatchObject({
      providerConversationKey: 'conversation-b',
      lastOpenedAt: 220,
    });
  });

  it('offers a new local wrapper instead of overwriting a bound session on manual navigation', async () => {
    const repository = createBrowserChatBindingRepository(
      testDatabase,
      () => 300,
      () => 'binding-original',
    );
    const originalChat: Chat = {
      id: 'chat-original' as ChatId,
      workspace_id: 'workspace-1' as WorkspaceId,
      project_id: 'project-1' as ProjectId,
      title: 'Original conversation',
      mode: 'chat',
      active_agent_ids: [],
      pinned: false,
      created_at: 1,
      updated_at: 1,
    };
    await testDatabase.chats.put(originalChat);
    const originalBinding = await repository.create({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      chatId: 'chat-original',
      provider: 'chatgpt',
      providerProfileKey: 'browser-chat/chatgpt',
      providerConversationKey: 'conversation-original',
      resumeUrl: 'https://chatgpt.com/c/conversation-original',
      bindingState: 'bound',
      localTitle: originalChat.title,
    });
    const createChat = vi.fn(async () => {
      const nextChat: Chat = {
        ...originalChat,
        id: 'chat-manual-new' as ChatId,
        title: 'ChatGPT conversation',
        created_at: 2,
        updated_at: 2,
      };
      await testDatabase.chats.put(nextChat);
      return nextChat.id;
    });

    renderHub(
      'chat-original',
      [{ binding: originalBinding, chat: originalChat }],
      undefined,
      undefined,
      createChat,
    );
    await act(async () => {
      providerSurfaceHarness.onNavigation?.({
        providerId: 'chatgpt',
        surfaceId: 'browser-chat-chatgpt',
        accountProfileKey: providerSurfaceHarness.accountProfileKey!,
        url: 'https://chatgpt.com/c/conversation-new',
        timestamp: 320,
        kind: 'conversation',
        providerConversationKey: 'conversation-new',
      });
    });

    expect(screen.getByText(/Unmapped ChatGPT conversation/i)).toBeTruthy();
    expect(await testDatabase.browser_chat_bindings.get(originalBinding.id)).toMatchObject({
      providerConversationKey: 'conversation-original',
      resumeUrl: 'https://chatgpt.com/c/conversation-original',
    });

    fireEvent.click(screen.getByRole('button', { name: /Save as Browser Chat/i }));
    await waitFor(async () =>
      expect(
        await repository.findByProviderConversation(
          { accountId: 'account-1', workspaceId: 'workspace-1' },
          {
            provider: 'chatgpt',
            providerProfileKey: `browser-chat/chatgpt/${providerSurfaceHarness.accountProfileKey!}`,
            providerConversationKey: 'conversation-new',
          },
        ),
      ).toMatchObject({
        chatId: 'chat-manual-new',
        resumeUrl: 'https://chatgpt.com/c/conversation-new',
        bindingState: 'bound',
        lastOpenedAt: 320,
      }),
    );
    expect(useUIStore.getState().activeChatId).toBe('chat-manual-new');
  });

  it('requires an explicit project grant before arming the local relay', () => {
    localStorage.setItem(
      projectStorageKey(ROOT_PREFIX, 'project-1'),
      'C:\\Users\\viper\\Projects\\Safe',
    );
    renderHub('chat-1');

    expect(browserChatWorkspaceGrantStore.getSnapshot()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /approve current project access/i }));

    expect(browserChatWorkspaceGrantStore.getSnapshot()).toMatchObject({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      canonicalRoot: 'C:\\Users\\viper\\Projects\\Safe',
      readAllowed: true,
      modifyAllowed: false,
      terminalAllowed: false,
    });
    expect(getBridgeWorkspaceGrant()).toMatchObject({
      workspaceId: 'workspace-1',
      root: 'C:\\Users\\viper\\Projects\\Safe',
      displayName: 'Safe',
    });
    expect(screen.getByText(/local relay armed/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /revoke project access/i }));
    expect(browserChatWorkspaceGrantStore.getSnapshot()).toBeNull();
    expect(getBridgeWorkspaceGrant()).toBeUndefined();
    expect(screen.getByText(/grant revoked/i)).toBeTruthy();
  });

  it('persists the selected permission plan by account/project and applies it to a live grant', async () => {
    localStorage.setItem(
      projectStorageKey(ROOT_PREFIX, 'project-1'),
      'C:\\Users\\viper\\Projects\\Safe',
    );
    const first = renderHub('chat-1');
    const selector = await screen.findByLabelText('VibeSpace permission plan');

    fireEvent.change(selector, { target: { value: 'project_developer' } });
    await waitFor(async () =>
      expect(
        await testDatabase.browser_chat_permission_profiles
          .where('[accountId+workspaceId+projectId]')
          .equals(['account-1', 'workspace-1', 'project-1'])
          .first(),
      ).toMatchObject({ plan: 'project_developer' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /approve current project access/i }));
    expect(getBridgeWorkspaceGrant()).toMatchObject({
      permissionProfile: { plan: 'project_developer' },
    });

    first.unmount();
    renderHub('chat-1');
    await waitFor(() =>
      expect((screen.getByLabelText('VibeSpace permission plan') as HTMLSelectElement).value).toBe(
        'project_developer',
      ),
    );
  });

  it('starts the authenticated relay for a signed-in account before local project access is granted', () => {
    bridge.publishBrowserChatRelayStatus('connected');

    renderHub('chat-1');

    expect(browserChatWorkspaceGrantStore.getSnapshot()).toBeNull();
    expect(screen.getByText(/connected to this signed-in vibespace account/i)).toBeTruthy();
  });

  it('shows a relay failure instead of falling back to a not-configured provider status', () => {
    bridge.publishBrowserChatRelayStatus('error');

    renderHub('chat-1');

    expect(screen.getAllByText(/connection error/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^setup required$/i)).toBeNull();
  });

  it('shows only account-scoped advertised, running, and last-result tool truth', () => {
    publishBrowserChatToolCatalog({
      accountId: 'account-1',
      toolNames: ['fs.read', 'fs.list'],
      now: 100,
    });
    beginBrowserChatToolCall({
      accountId: 'account-1',
      callId: 'call_completed0001',
      toolName: 'fs.list',
      now: 110,
    });
    finishBrowserChatToolCall({
      accountId: 'account-1',
      callId: 'call_completed0001',
      ok: false,
      errorCode: 'LOCAL_READ_DENIED',
      elapsedMs: 25,
      now: 135,
    });
    beginBrowserChatToolCall({
      accountId: 'account-1',
      callId: 'call_running000001',
      toolName: 'fs.read',
      now: 140,
    });

    renderHub('chat-1');

    expect(screen.getByText(/2 advertised · 1 running/i)).toBeTruthy();
    expect(screen.getByText(/^fs\.read running$/i)).toBeTruthy();
    expect(screen.getByText(/last: fs\.list · local read denied · 25 ms/i)).toBeTruthy();
  });

  it('presents one branded VibeSpace MCP connection with honest approval boundaries', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const fetcher = mockSuccessfulMcpDiscovery();
    const openPlugins = vi.spyOn(browserChatSurface, 'openChatGptPlugins').mockResolvedValue();

    renderHub('chat-1');

    expect(screen.getByText('VibeSpace MCP')).toBeTruthy();
    const permissionPlan = await screen.findByLabelText('VibeSpace permission plan');
    expect((permissionPlan as HTMLSelectElement).value).toBe('read');
    expect(screen.getByText(/write support not verified/i)).toBeTruthy();
    expect(screen.queryByText(/^file writes$/i)).toBeNull();
    expect(screen.getByText(/blocked by plan/i)).toBeTruthy();
    expect(screen.getByText('https://vibespace-mcp.fly.dev/mcp')).toBeTruthy();
    expect(screen.getAllByText(/enable developer mode/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/add vibespace mcp/i)).toBeTruthy();
    expect(screen.getByText(/approve access/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /connect vibespace mcp/i }));
    await waitFor(() => expect(openPlugins).toHaveBeenCalledOnce());

    expect(fetcher.mock.calls.map(([request]) => request.toString())).toEqual([
      'https://vibespace-mcp.fly.dev/health',
      'https://vibespace-mcp.fly.dev/.well-known/oauth-protected-resource',
      'https://auth.example/.well-known/oauth-authorization-server/auth/v1',
    ]);
    expect(writeText).toHaveBeenCalledWith('https://vibespace-mcp.fly.dev/mcp');
    expect(screen.getByText(/waiting for owner approval/i)).toBeTruthy();
    expect(screen.getByText(/one-time oauth approval/i)).toBeTruthy();
  });

  it('does not copy or navigate when MCP discovery fails', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 503 }));
    const openPlugins = vi.spyOn(browserChatSurface, 'openChatGptPlugins').mockResolvedValue();

    renderHub('chat-1');
    fireEvent.click(screen.getByRole('button', { name: /connect vibespace mcp/i }));

    expect(await screen.findByText(/health check failed/i)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
    expect(openPlugins).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /retry vibespace mcp/i })).toBeTruthy();
  });

  it('continues the safe browser handoff when clipboard access is denied', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockSuccessfulMcpDiscovery();
    const openPlugins = vi.spyOn(browserChatSurface, 'openChatGptPlugins').mockResolvedValue();

    renderHub('chat-1');
    fireEvent.click(screen.getByRole('button', { name: /connect vibespace mcp/i }));

    await waitFor(() => expect(openPlugins).toHaveBeenCalledOnce());
    expect(screen.getByText('https://vibespace-mcp.fly.dev/mcp')).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy mcp endpoint/i })).toBeTruthy();
    expect(screen.getByText(/waiting for owner approval/i)).toBeTruthy();
  });

  it('retains both setup URLs when the system browser cannot open', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    mockSuccessfulMcpDiscovery();
    vi.spyOn(browserChatSurface, 'openChatGptPlugins').mockRejectedValue(
      new Error('OS browser unavailable'),
    );

    renderHub('chat-1');
    fireEvent.click(screen.getByRole('button', { name: /connect vibespace mcp/i }));

    expect(await screen.findByText(/chatgpt apps could not be opened/i)).toBeTruthy();
    expect(screen.getByText('https://vibespace-mcp.fly.dev/mcp')).toBeTruthy();
    expect(screen.getByText('https://chatgpt.com/')).toBeTruthy();
  });
});
