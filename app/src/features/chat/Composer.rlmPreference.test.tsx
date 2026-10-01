import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { messageRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { resolveRlmEnabled, setChatRlmEnabled } from '@/features/context/rlmPreferenceStore';
import { readChatRuntimePolicyState } from './runtime/chatRuntimeSettingsStore';
import { Composer } from './Composer';

const fixture = vi.hoisted(() => ({ empty: [] as unknown[] }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_q: unknown, _d: unknown, fallback: unknown) =>
    Array.isArray(fallback) && fallback.length === 0 ? fixture.empty : fallback,
}));
vi.mock('./useChatBackendAffinity', () => ({ useChatBackendAffinity: () => undefined }));
vi.mock('./HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'missing' }),
}));
const originalAuth = useAuthStore.getState();
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useAuthStore.setState({
    workspaceId: 'rlm-test-workspace' as never,
    projectId: 'rlm-test-project' as never,
    chatModelSelection: { mode: 'none' },
  });
  vi.spyOn(messageRepo, 'create').mockResolvedValue({ id: 'rlm-test-message' } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.setState(originalAuth);
});

it('typed /rlm off disables both the runtime route and actual context tools after remount', async () => {
  const chatId = 'rlm-typed-off';
  const view = render(
    <TooltipProvider>
      <Composer chatId={chatId as never} />
    </TooltipProvider>,
  );
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: '/rlm off' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(readChatRuntimePolicyState(chatId).settings.rlmEnabled).toBe(false));
  expect(resolveRlmEnabled({ chatId }).enabled).toBe(false);
  view.unmount();
  render(
    <TooltipProvider>
      <Composer chatId={chatId as never} />
    </TooltipProvider>,
  );
  expect(readChatRuntimePolicyState(chatId).settings.rlmEnabled).toBe(false);
  expect(resolveRlmEnabled({ chatId }).enabled).toBe(false);
});

it('an existing explicit context preference off is honored by the runtime route on mount', async () => {
  const chatId = 'rlm-existing-off';
  setChatRlmEnabled(chatId, false);
  render(
    <TooltipProvider>
      <Composer chatId={chatId as never} />
    </TooltipProvider>,
  );
  await waitFor(() => expect(readChatRuntimePolicyState(chatId).settings.rlmEnabled).toBe(false));
  expect(resolveRlmEnabled({ chatId }).enabled).toBe(false);
});
