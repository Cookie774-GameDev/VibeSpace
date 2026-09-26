import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui';
import { checkpointNotesComposer } from '@/features/notes/notesComposerDraft';
import { jarvisArtifactRepo } from '@/lib/db/jarvisRepositories';
import type { JarvisArtifactV1 } from '@/lib/jarvis/contracts/execution';
import { useAuthStore } from '@/stores/auth';
import { Composer } from './Composer';

const liveQueryFixture = vi.hoisted(() => ({ emptyArray: [] as unknown[] }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, defaultValue: unknown) =>
    Array.isArray(defaultValue) && defaultValue.length === 0
      ? liveQueryFixture.emptyArray
      : defaultValue,
}));
vi.mock('./HarnessReadinessGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./HarnessReadinessGate')>();
  return {
    ...actual,
    useHarnessRuntimeState: () => ({
      kind: 'ready' as const,
      source: 'managed' as const,
      version: 'test-runtime',
    }),
  };
});

const originalAuth = useAuthStore.getState();
const composerChatId = 'chat-md-refresh';
const composerNoteScope = { accountId: 'account-alpha', projectId: 'project-1' } as const;

function artifact(
  id: string,
  title: string,
  overrides: Partial<JarvisArtifactV1> = {},
): JarvisArtifactV1 {
  return {
    schemaVersion: 1,
    id,
    runId: `jrun_${id}`,
    requestId: `jreq_${id}`,
    attemptNumber: 1,
    state: 'ready',
    kind: 'document',
    title,
    sourceRefs: [],
    createdAt: 100,
    ...overrides,
  };
}

function renderComposer() {
  return render(
    <TooltipProvider>
      <Composer chatId={composerChatId as never} />
    </TooltipProvider>,
  );
}

function openMentionPicker() {
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: '@', selectionStart: 1 } });
  return input;
}

describe('Composer canonical artifact refresh', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => undefined,
    });
    useAuthStore.setState({
      localUserId: 'account-alpha',
      cloudSession: null,
      workspaceId: 'workspace-1' as never,
      projectId: 'project-1' as never,
    });
    checkpointNotesComposer(composerNoteScope, composerChatId, '', []);
  });

  afterEach(() => {
    cleanup();
    checkpointNotesComposer(composerNoteScope, composerChatId, '', []);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useAuthStore.setState({
      localUserId: originalAuth.localUserId,
      cloudSession: originalAuth.cloudSession,
      workspaceId: originalAuth.workspaceId,
      projectId: originalAuth.projectId,
    });
  });

  it('refreshes newly committed artifacts whenever mixed reference discovery opens', async () => {
    const created = artifact('jart_design-md', 'Design MD');
    const list = vi
      .spyOn(jarvisArtifactRepo, 'listByAccount')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([created]);

    renderComposer();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    openMentionPicker();

    expect(await screen.findByRole('option', { name: /Design MD/i })).toBeTruthy();
    expect(screen.getByText('@artifact:jart_design-md')).toBeTruthy();
    expect(list).toHaveBeenNthCalledWith(2, 'account-alpha', 100);
  });

  it('contains a refresh failure and removes stale artifact choices', async () => {
    const previous = artifact('jart_previous-md', 'Previous MD');
    const list = vi
      .spyOn(jarvisArtifactRepo, 'listByAccount')
      .mockResolvedValueOnce([previous])
      .mockRejectedValueOnce(new Error('indexed db unavailable'));

    renderComposer();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    openMentionPicker();

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('@artifact:jart_previous-md')).toBeNull());
    expect(screen.getByText('@CAO')).toBeTruthy();
  });

  it('discards a stale refresh after the canonical account changes', async () => {
    let resolveAlpha!: (artifacts: JarvisArtifactV1[]) => void;
    const alphaRefresh = new Promise<JarvisArtifactV1[]>((resolve) => {
      resolveAlpha = resolve;
    });
    const list = vi
      .spyOn(jarvisArtifactRepo, 'listByAccount')
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => alphaRefresh)
      .mockResolvedValueOnce([]);

    renderComposer();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    openMentionPicker();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await act(async () => {
      useAuthStore.setState({ localUserId: 'account-beta' });
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    await act(async () => {
      resolveAlpha([artifact('jart_alpha-private', 'Alpha private')]);
      await alphaRefresh;
    });

    await waitFor(() => expect(screen.queryByText('@artifact:jart_alpha-private')).toBeNull());
    expect(list).toHaveBeenNthCalledWith(3, 'account-beta', 100);
  });
});
