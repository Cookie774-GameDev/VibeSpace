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
import { collectAuditEvidence } from './auditEvidence';
beforeEach(() => openVibeCheck('source'));
afterEach(() => {
  cleanup();
  closeVibeCheck();
});
describe('VibeCheck panel', () => {
  it('reveals incremental scores with evidence and keeps protocol text out of the report', () => {
    render(<VibeCheckPanel />);
    const id = useVibeCheckStore.getState().session!.id;
    const record =
      'VIBECHECK_GRADE ' +
      JSON.stringify({
        metric: 'quality',
        score: 82,
        reason: 'Focused changes',
        evidence: 'src/main.ts:12',
        confidence: 'medium',
      });
    act(() =>
      patchAudit(id, { report: 'Early finding\n' + record.slice(0, -1), status: 'running' }),
    );
    expect(screen.getByLabelText('Quality score').textContent).toBe('—');
    act(() => patchAudit(id, { report: 'Early finding\n' + record }));
    expect(screen.getByLabelText('Quality score').textContent).toBe('82/100');
    expect(screen.getByText('1/6 reported')).toBeTruthy();
    expect(screen.getByLabelText('Audit report').textContent).toBe('Early finding');
    expect(screen.getByText('src/main.ts:12')).toBeTruthy();
  });
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

  it('distinguishes model judgments and retained evidence from live verified measurements', () => {
    const id = useVibeCheckStore.getState().session!.id;
    patchAudit(id, { evidence: collectAuditEvidence([], []), progress: 75, status: 'running' });
    render(<VibeCheckPanel />);
    expect(screen.getByText(/Scores are the auditor’s judgments/)).toBeTruthy();
    expect(screen.getByText(/Snapshot of retained chat records/)).toBeTruthy();
    expect(screen.queryByText('75%')).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
    expect(screen.getByText('Recorded evidence')).toBeTruthy();
  });

  it('shows unknown freshness for an older in-memory snapshot instead of crashing', () => {
    const id = useVibeCheckStore.getState().session!.id;
    patchAudit(id, {
      evidence: { ...collectAuditEvidence([], []), capturedAt: undefined } as never,
    });
    render(<VibeCheckPanel />);
    expect(screen.getByText('Capture time unavailable')).toBeTruthy();
  });
});
