import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { messageRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { runVibeSpaceDoctor } from '@/features/doctor/vibeSpaceDoctor';
import { Composer } from './Composer';

const fixture = vi.hoisted(() => ({ empty: [] as unknown[] }));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: (_q: unknown, _d: unknown, fallback: unknown) => Array.isArray(fallback) && fallback.length === 0 ? fixture.empty : fallback }));
vi.mock('./useChatBackendAffinity', () => ({ useChatBackendAffinity: () => undefined }));
vi.mock('./HarnessReadinessGate', async original => ({ ...(await original<typeof import('./HarnessReadinessGate')>()), useHarnessRuntimeState: () => ({ kind: 'missing' }) }));
vi.mock('@/features/doctor/vibeSpaceDoctor', () => ({ runVibeSpaceDoctor: vi.fn() }));

const originalAuth = useAuthStore.getState();
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useAuthStore.setState({ workspaceId: 'slash-test-workspace' as never, projectId: 'slash-test-project' as never, chatModelSelection: { mode: 'none' } });
  vi.spyOn(messageRepo, 'create').mockResolvedValue({ id: 'slash-test-message' } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAuthStore.setState(originalAuth); });

function submit(command: string) {
  render(<TooltipProvider><Composer chatId={'slash-progress-test' as never} /></TooltipProvider>);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: command } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

it('shows Doctor running then an attention result after the real promise settles', async () => {
  let finish!: (report: Awaited<ReturnType<typeof runVibeSpaceDoctor>>) => void;
  vi.mocked(runVibeSpaceDoctor).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  submit('/doctor');
  await waitFor(() => expect(document.querySelector('[data-slash-command-state="running"]')).not.toBeNull());
  await waitFor(() => expect(runVibeSpaceDoctor).toHaveBeenCalled());
  finish({ ok: false, text: 'Cloud account needs attention', stages: [] });
  await waitFor(() => expect(document.querySelector('[data-slash-command-state="failed"]')).not.toBeNull());
  expect(document.querySelector('[data-slash-command-state="running"]')).toBeNull();
});

it('shows completion for another local slash command without a model', async () => {
  submit('/performance status');
  await waitFor(() => expect(document.querySelector('[data-slash-command-state="succeeded"]')).not.toBeNull());
  expect(screen.getByText(/\/performance · Completed/)).toBeTruthy();
});

it('leaves a failed terminal status when saving a command result fails', async () => {
  vi.mocked(messageRepo.create).mockRejectedValueOnce(new Error('private token'));
  submit('/performance status');
  await waitFor(() => expect(document.querySelector('[data-slash-command-state="failed"]')).not.toBeNull());
  expect(screen.queryByText(/private token/)).toBeNull();
});
