import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { General } from './General';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('General Agent Relay settings', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({});
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('lets the user opt into Project scope and automatic check-ins', () => {
    render(<General />);

    const scope = screen.getByRole('combobox', { name: 'Agent Relay collaboration scope' });
    expect(scope).toHaveProperty('value', 'off');
    expect(screen.getByRole('option', { name: 'Project (recommended)' })).toBeTruthy();
    expect(
      screen.getByText(/enabled projects in this account, workspace, and profile/i),
    ).toBeTruthy();
    fireEvent.change(scope, { target: { value: 'project' } });
    fireEvent.click(
      screen.getByRole('switch', { name: 'Automatic Agent Relay check-ins and replies' }),
    );

    expect(localStorage.getItem('vibespace:agent-relay:settings:v1')).toContain(
      '"scope":"project"',
    );
    expect(localStorage.getItem('vibespace:agent-relay:settings:v1')).toContain(
      '"automaticParticipation":true',
    );
  });

  it('persists participation exclusions and does not claim an unverified connection', () => {
    render(<General />);
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Agent Relay excluded project and session IDs' }),
      {
        target: { value: 'project-private\nsession-private' },
      },
    );

    expect(localStorage.getItem('vibespace:agent-relay:settings:v1')).toContain(
      '"excludedParticipants":["project-private","session-private"]',
    );
    expect(
      screen.getByText(
        'No authenticated Relay exchange has been verified in this settings session.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/does not verify that another agent responded/i)).toBeTruthy();
  });

  it('updates the controls when another app window changes the saved policy', () => {
    render(<General />);

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'vibespace:agent-relay:settings:v1',
          newValue: JSON.stringify({
            scope: 'entire-app',
            automaticParticipation: true,
            excludedParticipants: ['private-session'],
          }),
        }),
      );
    });

    expect(
      screen.getByRole('combobox', { name: 'Agent Relay collaboration scope' }),
    ).toHaveProperty('value', 'entire-app');
    expect(
      screen
        .getByRole('switch', { name: 'Automatic Agent Relay check-ins and replies' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByRole('textbox', { name: 'Agent Relay excluded project and session IDs' }),
    ).toHaveProperty('value', 'private-session');
  });

  it('reports native engine health without claiming an authenticated exchange', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.mocked(invoke).mockResolvedValue({ running: true, healthy: true });
    render(<General />);

    expect(
      await screen.findByText(
        'Local Relay backend health check passed. This does not verify a participant exchange.',
      ),
    ).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('relay_engine_status');
    expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('shows an unhealthy native backend distinctly from an unavailable one', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.mocked(invoke).mockResolvedValue({ running: true, healthy: false });
    render(<General />);

    expect(
      await screen.findByText('Local Relay backend is running but failed its health check.'),
    ).toBeTruthy();
  });

  it('does not infer health from a running process when the probe is missing', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.mocked(invoke).mockResolvedValue({ running: true });
    render(<General />);

    expect(
      await screen.findByText(
        'This app build did not return a verifiable Relay backend health status.',
      ),
    ).toBeTruthy();
  });

  it('reports a stopped native backend without enabling the exchange test', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.mocked(invoke).mockResolvedValue({ running: false, healthy: false });
    render(<General />);

    expect(
      await screen.findByText('Local Relay backend is stopped or its status could not be read.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('tests a real authenticated human send/read round trip before showing success', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    let sentText = '';
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'relay_engine_status') return { running: false, healthy: false };
      if (command === 'relay_active_context_snapshot') return {
        generation: 3, context: {
          accountId: 'account', workspaceId: 'workspace', projectId: 'project', chatId: 'chat',
        },
      };
      if (command === 'relay_participant_bind') return { bindingId: 'binding', relayAgentId: 'human' };
      if (command === 'relay_human_message') {
        sentText = (args as { text: string }).text;
        return { messageId: 'posted-message' };
      }
      if (command === 'relay_human_room_snapshot') return { channel: 'vibespace',
        messages: [{ id: 'posted-message', authorId: 'human', text: sentText }] };
      return {};
    });
    render(<General />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent Relay collaboration scope' }), {
      target: { value: 'project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByText(/Authenticated send\/read round trip passed/i)).toBeTruthy());
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(expect.arrayContaining([
      'relay_engine_start', 'relay_participant_bind', 'relay_human_message',
      'relay_human_room_snapshot', 'relay_participant_unbind',
    ]));
    expect(screen.getByText(/Agent reply was not tested/i)).toBeTruthy();
  });
});
