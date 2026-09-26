import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RelayGroupChat } from './RelayGroupChat';

afterEach(cleanup);

const room = {
  connection: 'connected' as const,
  scope: 'Project' as const,
  participants: [
    { id: 'human-1', name: 'You', kind: 'human' as const, status: 'online' as const },
    { id: 'agent-1', name: 'Luna', kind: 'agent' as const, status: 'busy' as const },
  ],
  messages: [
    { id: 'm1', participantId: 'agent-1', text: 'I am checking the tests.', at: 1000, kind: 'message' as const },
  ],
};

it('shows a genuine bounded group chat and sends as the verified human without a fake echo', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  render(<RelayGroupChat open room={room} humanAuthorized onClose={() => {}} onSend={send} onStopAll={() => {}} />);
  expect(screen.getByRole('dialog', { name: 'Agent Relay group chat' })).toBeTruthy();
  expect(screen.getAllByText('Luna')).toHaveLength(2);
  expect(screen.getByText('I am checking the tests.')).toBeTruthy();
  expect(screen.getByText('You')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Agent Relay' }), { target: { value: 'Please share status.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to group' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenCalledWith('Please share status.');
  expect(screen.queryByText('Please share status.')).toBeNull();
});

it('requires a second explicit owner action to stop agents and hides it without verified human authority', async () => {
  const stop = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(<RelayGroupChat open room={room} humanAuthorized={false} onClose={() => {}} onSend={() => {}} onStopAll={stop} />);
  expect(screen.queryByRole('button', { name: 'Stop agents' })).toBeNull();
  rerender(<RelayGroupChat open room={room} humanAuthorized onClose={() => {}} onSend={() => {}} onStopAll={stop} />);
  fireEvent.click(screen.getByRole('button', { name: 'Stop agents' }));
  expect(stop).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm stop agents' }));
  await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
});

it('keeps posting disabled while Relay is offline and shows no invented participants', () => {
  render(<RelayGroupChat open room={{ connection: 'offline', scope: 'Project', participants: [], messages: [] }} humanAuthorized onClose={() => {}} onSend={() => {}} onStopAll={() => {}} />);
  expect(screen.getByText('Relay is offline')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Send to group' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText('Luna')).toBeNull();
});
