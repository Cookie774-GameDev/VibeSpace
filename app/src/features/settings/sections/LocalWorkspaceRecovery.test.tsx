import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore, getLocalWorkspaceRecoveryRevision } from '@/stores/auth';
import { revokeLocalAccountReadiness } from '@/lib/localAccountReadiness';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { LocalWorkspaceRecovery } from './LocalWorkspaceRecovery';
const service = vi.hoisted(() => ({ preview: vi.fn(), recover: vi.fn() }));
vi.mock('@/features/access/localWorkspaceRecovery', () => ({
  previewLocalWorkspaceRecovery: service.preview,
  recoverLocalWorkspace: service.recover,
}));
const source = {
  localUserId: 'usr_test',
  workspaceId: 'wks_missing' as WorkspaceId,
  projectId: 'prj_orphan' as ProjectId,
};
const target = {
  ...source,
  workspaceId: 'wks_new' as WorkspaceId,
  projectId: 'prj_new' as ProjectId,
};
beforeEach(() => {
  vi.resetAllMocks();
  useAuthStore.setState({ ...source, cloudSession: null });
  service.preview.mockResolvedValue({ kind: 'create', accountId: source.localUserId });
  service.recover.mockImplementation(async () => {
    useAuthStore.setState(target);
    return { scope: target, revision: getLocalWorkspaceRecoveryRevision() };
  });
});
afterEach(cleanup);
const check = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Check local workspace recovery' }));
  await screen.findByRole('checkbox');
};
describe('explicit Account local workspace recovery', () => {
  it('requires a user check and separate confirmation; preserves disclosure', async () => {
    render(<LocalWorkspaceRecovery />);
    expect(service.preview).not.toHaveBeenCalled();
    expect(service.recover).not.toHaveBeenCalled();
    expect(screen.getByText(/does not reconnect orphaned records/)).toBeTruthy();
    await check();
    const apply = screen.getByRole('button', { name: 'Create local workspace' });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(apply);
    expect(service.recover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(apply);
    await screen.findByText(/new local workspace and Inbox are ready/);
    expect(service.recover).toHaveBeenCalledTimes(1);
  });
  it.each(['scope', 'cloud', 'readiness'])('clears confirmation when %s changes', async (kind) => {
    render(<LocalWorkspaceRecovery />);
    await check();
    fireEvent.click(screen.getByRole('checkbox'));
    act(() => {
      if (kind === 'scope') useAuthStore.setState({ projectId: 'prj_other' as ProjectId });
      if (kind === 'cloud')
        useAuthStore.setState({ cloudSession: { user_id: 'cloud', email: '', expires_at: 1 } });
      if (kind === 'readiness') revokeLocalAccountReadiness();
    });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(service.recover).not.toHaveBeenCalled();
  });
  it('ignores a late check result after scope ABA', async () => {
    let resolve!: (value: unknown) => void;
    service.preview.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<LocalWorkspaceRecovery />);
    fireEvent.click(screen.getByRole('button', { name: 'Check local workspace recovery' }));
    act(() => {
      useAuthStore.setState({ projectId: 'prj_other' as ProjectId });
      useAuthStore.setState(source);
    });
    await act(async () => {
      resolve({ kind: 'create', accountId: source.localUserId });
    });
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('shows failure and requires a fresh check before retry', async () => {
    service.recover.mockRejectedValue(new Error('Saved recovery can be resumed.'));
    render(<LocalWorkspaceRecovery />);
    await check();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Create local workspace' }));
    await screen.findByText('Saved recovery can be resumed.');
    expect(screen.queryByRole('checkbox')).toBeNull();
    await check();
    expect(
      (screen.getByRole('button', { name: 'Create local workspace' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it('does not show success for a newer selection after recovery resolves', async () => {
    service.recover.mockImplementation(async () => {
      useAuthStore.setState(target);
      const revision = getLocalWorkspaceRecoveryRevision();
      useAuthStore.setState({ projectId: 'prj_other' as ProjectId });
      useAuthStore.setState(target);
      return { scope: target, revision };
    });
    render(<LocalWorkspaceRecovery />);
    await check();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Create local workspace' }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Check local workspace recovery',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.queryByText(/new local workspace and Inbox are ready/)).toBeNull();
  });
});


describe('independent UI repetition and authority checks', () => {
  it('drops repeated check clicks while its check is pending', async () => {
    let resolve!: (value: unknown) => void;
    service.preview.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<LocalWorkspaceRecovery />);
    const button = screen.getByRole('button', { name: 'Check local workspace recovery' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(service.preview).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ kind: 'create', accountId: source.localUserId }); });
    expect(screen.getByRole('checkbox')).toBeTruthy();
  });
  it('drops repeated create clicks before the recovery settles', async () => {
    let resolve!: (value: unknown) => void;
    service.recover.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<LocalWorkspaceRecovery />);
    await check();
    fireEvent.click(screen.getByRole('checkbox'));
    const button = screen.getByRole('button', { name: 'Create local workspace' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(service.recover).toHaveBeenCalledTimes(1);
    await act(async () => {
      useAuthStore.setState(target);
      resolve({ scope: target, revision: getLocalWorkspaceRecoveryRevision() });
    });
    expect(screen.getByText(/new local workspace and Inbox are ready/)).toBeTruthy();
  });
  it('does not display a late successful recovery for a different current account', async () => {
    let resolve!: (value: unknown) => void;
    service.recover.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<LocalWorkspaceRecovery />);
    await check();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Create local workspace' }));
    await act(async () => {
      useAuthStore.setState({ ...target, localUserId: 'usr_someone_else' });
      resolve({ scope: target, revision: getLocalWorkspaceRecoveryRevision() });
    });
    expect(screen.queryByText(/new local workspace and Inbox are ready/)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('ignores a late preview after unmount', async () => {
    let resolve!: (value: unknown) => void;
    service.preview.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<LocalWorkspaceRecovery />);
    fireEvent.click(screen.getByRole('button', { name: 'Check local workspace recovery' }));
    view.unmount();
    await act(async () => { resolve({ kind: 'create', accountId: source.localUserId }); });
    expect(service.recover).not.toHaveBeenCalled();
  });
});
