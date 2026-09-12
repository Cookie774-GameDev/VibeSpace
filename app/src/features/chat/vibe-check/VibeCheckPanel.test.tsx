import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({ workspaceId: 'ws', projectId: null }),
    subscribe: () => () => {},
  },
}));
vi.mock('@/lib/accountIdentity', () => ({
  resolveAccountIdentity: () => ({ accountId: 'owner' }),
}));
vi.mock('@/stores/ui', () => ({ useUIStore: { getState: () => ({ setActiveChat: vi.fn() }) } }));
import { VibeCheckPanel } from './VibeCheckPanel';
import { closeVibeCheck, openVibeCheck, patchAudit, useVibeCheckStore } from './vibeCheckStore';
import { classifySlashCommand } from '../slashCommandRouting';
beforeEach(() => openVibeCheck('source'));
afterEach(() => {
  cleanup();
  closeVibeCheck();
});
describe('VibeCheck panel', () => {
  it('routes mixed-case slash locally', () =>
    expect(classifySlashCommand('/VibeCheck')).toMatchObject({
      command: 'vibecheck',
      execution: 'local',
    }));
  it('retains options and report across minimize and view remount', () => {
    const view = render(<VibeCheckPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Main agent/ }));
    const id = useVibeCheckStore.getState().session!.id;
    act(() => patchAudit(id, { report: 'Audited evidence' }));
    const body = view.container.querySelector('.vibe-check-body')!;
    fireEvent.scroll(body, { target: { scrollTop: 180 } });
    fireEvent.click(screen.getByRole('button', { name: 'Minimize VibeCheck' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    view.unmount();
    render(<VibeCheckPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore VibeCheck' }));
    expect(screen.getByRole('button', { name: /Main agent/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByLabelText('Audit report').textContent).toBe('Audited evidence');
    expect(document.querySelector('.vibe-check-body')?.scrollTop).toBe(180);
  });
  it('requires confirmation before resetting', () => {
    render(<VibeCheckPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Close VibeCheck' }));
    expect(useVibeCheckStore.getState().session).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep audit' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close VibeCheck' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close audit' }));
    expect(useVibeCheckStore.getState().session).toBeNull();
    act(() => openVibeCheck('source'));
    expect(useVibeCheckStore.getState().session?.status).toBe('ready');
  });
});
