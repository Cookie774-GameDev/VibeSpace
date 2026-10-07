import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { Composer } from './Composer';
import { GEMINI_API_CONNECTION } from '@/lib/ai/adapters/nativeCatalog';
import { resetDiscoveredConnectionModelsForTests, setDiscoveredConnectionModels } from '@/lib/ai/connectionCatalog';
import { selectionFromOption } from '@/lib/ai/modelSelection';

const fixture = vi.hoisted(() => ({ empty: [] as unknown[], start: vi.fn(), focus: vi.fn(), sound: vi.fn(), error: vi.fn() }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, fallback: unknown) =>
    Array.isArray(fallback) && fallback.length === 0 ? fixture.empty : fallback,
}));
vi.mock('./useChatBackendAffinity', () => ({ useChatBackendAffinity: () => undefined }));
vi.mock('./HarnessReadinessGate', async original => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready', source: 'managed' }),
}));
vi.mock('@/features/voice/voiceTypedAgentFlow', () => ({ startTypedAgentOverride: fixture.start }));
vi.mock('@/features/voice/voiceChatRouting', async original => ({
  ...(await original<typeof import('@/features/voice/voiceChatRouting')>()), focusVoiceChat: fixture.focus,
}));
vi.mock('@/lib/sfx', () => ({ playUiSound: fixture.sound }));
vi.mock('@/components/ui/toast', async original => ({
  ...(await original<typeof import('@/components/ui/toast')>()),
  toast: { info: vi.fn(), warning: vi.fn(), success: vi.fn(), error: fixture.error },
}));

const originalAuth = useAuthStore.getState();
const originalUi = useUIStore.getState();
const prompt = 'Use OpenCode for the main agent and Codex for the worker: inspect the selected project.';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(chatId: string) {
  return render(<TooltipProvider><Composer chatId={chatId as never} /></TooltipProvider>);
}
function input() { return screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement; }
function edit(value: string) { fireEvent.change(input(), { target: { value } }); }
async function submit() {
  edit(prompt);
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(fixture.start).toHaveBeenCalledOnce());
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.start.mockReset();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  setDiscoveredConnectionModels(GEMINI_API_CONNECTION.id, [
    { id: 'gemini-2.5-flash', label: 'Synthetic fixture', source: 'provider_list', lastVerifiedAt: 1 },
  ]);
  useAuthStore.setState({ localUserId: 'override-owner', cloudSession: null,
    workspaceId: 'override-workspace' as never, projectId: 'override-project' as never,
    apiKeys: { google: 'synthetic-test-key' }, offlineMode: false,
    chatModelSelection: selectionFromOption('google', 'gemini-2.5-flash', GEMINI_API_CONNECTION) });
  useUIStore.setState({ route: 'chat', settingsOpen: false });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  useAuthStore.setState(originalAuth); useUIStore.setState(originalUi);
  resetDiscoveredConnectionModelsForTests();
});

describe('Composer accepted provider override publication', () => {
  it.each(['account', 'workspace', 'project', 'account-aba', 'workspace-aba', 'project-aba'] as const)(
    'keeps another scope draft/focus intact after an accepted %s transition', async boundary => {
      const accepted = deferred<string>(); fixture.start.mockReturnValueOnce(accepted.promise);
      mount(`override-${boundary}`); await submit();
      const key = boundary.startsWith('account') ? 'localUserId' : boundary.startsWith('workspace') ? 'workspaceId' : 'projectId';
      const initial = useAuthStore.getState()[key];
      act(() => {
        useAuthStore.setState({ [key]: 'other-scope' });
        if (boundary.endsWith('-aba')) useAuthStore.setState({ [key]: initial });
      });
      // Preserve the current field even if React batched the ABA into one render.
      const currentDraft = input().value;
      await act(async () => { accepted.resolve('accepted-original-chat'); await accepted.promise; });
      expect(input().value).toBe(currentDraft);
      expect(fixture.focus).not.toHaveBeenCalled();
      expect(fixture.sound).not.toHaveBeenCalled();
      expect(fixture.error).not.toHaveBeenCalled();
      expect(fixture.start).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])('does not publish into a changed chat view (ABA=%s)', async aba => {
    const accepted = deferred<string>(); fixture.start.mockReturnValueOnce(accepted.promise);
    const view = mount(`override-chat-${aba}`); await submit();
    view.rerender(<TooltipProvider><Composer chatId={'another-chat' as never} /></TooltipProvider>);
    if (aba) view.rerender(<TooltipProvider><Composer chatId={`override-chat-${aba}` as never} /></TooltipProvider>);
    const currentDraft = input().value;
    await act(async () => { accepted.resolve('accepted-original-chat'); await accepted.promise; });
    expect(input().value).toBe(currentDraft);
    expect(fixture.focus).not.toHaveBeenCalled();
    expect(fixture.error).not.toHaveBeenCalled();
  });

  it('preserves a newer draft in the same view after the original task is accepted', async () => {
    const accepted = deferred<string>(); fixture.start.mockReturnValueOnce(accepted.promise);
    mount('override-newer-draft'); await submit(); edit('Keep this newer draft.');
    await act(async () => { accepted.resolve('accepted-original-chat'); await accepted.promise; });
    expect(input().value).toBe('Keep this newer draft.');
    expect(fixture.focus).not.toHaveBeenCalled();
    expect(fixture.start).toHaveBeenCalledOnce();
  });

  it('does not focus a completed task after its Composer unmounts', async () => {
    const accepted = deferred<string>(); fixture.start.mockReturnValueOnce(accepted.promise);
    const view = mount('override-unmounted'); await submit(); view.unmount();
    await act(async () => { accepted.resolve('accepted-original-chat'); await accepted.promise; });
    expect(fixture.focus).not.toHaveBeenCalled();
    expect(fixture.sound).not.toHaveBeenCalled();
    expect(fixture.error).not.toHaveBeenCalled();
  });

  it('still clears its own unchanged draft and focuses an accepted task once', async () => {
    const accepted = deferred<string>(); fixture.start.mockReturnValueOnce(accepted.promise);
    mount('override-unchanged'); await submit();
    await act(async () => { accepted.resolve('accepted-original-chat'); await accepted.promise; });
    expect(input().value).toBe('');
    expect(fixture.focus).toHaveBeenCalledExactlyOnceWith('accepted-original-chat');
    expect(fixture.sound).toHaveBeenCalledExactlyOnceWith('chat_message_send');
    expect(fixture.error).not.toHaveBeenCalled();
  });

  it('does not present a stale failed request in another scope', async () => {
    const pending = deferred<string>(); fixture.start.mockReturnValueOnce(pending.promise);
    mount('override-stale-error'); await submit();
    act(() => useAuthStore.setState({ projectId: 'another-project' as never }));
    edit('Draft in the other project.');
    await act(async () => { pending.reject(new Error('Original scope revoked')); await pending.promise.catch(() => undefined); });
    expect(input().value).toBe('Draft in the other project.');
    expect(fixture.focus).not.toHaveBeenCalled();
    expect(fixture.error).not.toHaveBeenCalled();
  });

  it('keeps a current-view failure visible and preserves its draft for retry', async () => {
    const pending = deferred<string>(); fixture.start.mockReturnValueOnce(pending.promise);
    mount('override-current-error'); await submit();
    await act(async () => { pending.reject(new Error('Synthetic route unavailable')); await pending.promise.catch(() => undefined); });
    expect(input().value).toBe(prompt);
    expect(fixture.focus).not.toHaveBeenCalled();
    expect(fixture.error).toHaveBeenCalledExactlyOnceWith('Provider override failed', 'Synthetic route unavailable');
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(false);
  });
});
