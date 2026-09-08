import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaoCommandPanel } from './CaoCommandPanel';
import type { CaoChatCommandRecord } from './chatCommands';
const mocks = vi.hoisted(() => ({ record: undefined as CaoChatCommandRecord | undefined, prepare: vi.fn(), decide: vi.fn(), cancel: vi.fn() }));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => mocks.record }));
vi.mock('./chatCommandProduction', () => ({ caoChatCommands: { prepare: mocks.prepare, decide: mocks.decide, cancel: mocks.cancel, recover: vi.fn(async () => {}) } }));
const scope = { accountId: 'account-1', workspaceId: 'workspace-1', projectId: 'project-1' };
beforeEach(() => {
  vi.clearAllMocks(); mocks.prepare.mockResolvedValue({}); mocks.decide.mockResolvedValue({});
  mocks.record = { ...scope, schemaVersion: 1, requestId: 'command-1', runId: 'run-1', callerChatId: 'chat-1', authorization: 'hash',
    command: { action: 'restart', source: 'natural-language', selectors: [{ kind: 'chat', by: 'id', selector: 'target-1' }] },
    bindings: [{ target: { kind: 'chat', targetId: 'target-1', revision: 1 }, signature: 'target' }],
    status: 'awaiting_approval', effects: [], createdAt: 1, updatedAt: 1 };
});
describe('CAO command approvals', () => {
  it('requires an explicit click and binds the decision to the saved account and request', async () => {
    render(<CaoCommandPanel scope={scope} chatId="chat-1" />);
    expect(mocks.decide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve CAO command' }));
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith('account-1', 'command-1', 'approve'));
  });
  it('does not render another account’s saved approval while the query refreshes', () => {
    render(<CaoCommandPanel scope={{ ...scope, accountId: 'account-2' }} chatId="chat-1" />);
    expect(screen.queryByRole('button', { name: 'Approve CAO command' })).toBeNull();
    expect(screen.queryByText(/target-1/)).toBeNull();
  });
  it('shows the persisted result after remount without executing again', () => {
    mocks.record!.status = 'completed'; mocks.record!.report = 'Exact request resumed; task completion is not established.';
    render(<CaoCommandPanel scope={scope} chatId="chat-1" />);
    expect(screen.getByText(/Exact request resumed/)).toBeTruthy();
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.decide).not.toHaveBeenCalled();
  });
});
