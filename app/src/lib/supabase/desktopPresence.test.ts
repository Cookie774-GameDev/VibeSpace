import { describe, expect, it, vi } from 'vitest';
import {
  markDesktopPresenceOffline,
  publishDesktopPresence,
  sanitizeDesktopPresence,
} from './desktopPresence';

describe('desktop presence boundary', () => {
  const accountA = '11111111-1111-4111-8111-111111111111';
  const accountB = '22222222-2222-4222-8222-222222222222';

  it('publishes only bounded metadata and omits raw desktop content', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const raw = {
      deviceId: 'device_12345678',
      displayName: '  Main\nPC  ',
      appVersion: '1.5.0',
      terminals: Array.from({ length: 55 }, (_, index) => ({
        id: `pty_${index}`,
        name: index === 0 ? 'Shell\u0000 pane' : `Pane ${index}`,
        status: 'active',
      })),
      chats: [{ id: 'chat_1', name: 'Release planning', status: 'open' }],
      agentJobs: [{ id: 'agent_1', name: 'Builder', status: 'running' }],
      activeRuntime: 'Ollama · llama3.2:latest',
      providerUsage: { ollama: { requests: 3 } },
      backgroundTaskCount: 2,
      recentSyncAt: '2026-08-09T01:00:00.000Z',
    };

    const result = await publishDesktopPresence({ rpc }, accountA, raw);

    expect(result).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [, payload] = rpc.mock.calls[0];
    expect(payload.p_expected_user_id).toBe(accountA);
    expect(payload.p_display_name).toBe('Main PC');
    expect(payload.p_active_terminals).toHaveLength(50);
    expect(payload.p_active_terminals[0]).toEqual({
      id: 'pty_0',
      name: 'Shell pane',
      status: 'active',
    });
    const { p_expected_user_id: _expectedUserId, ...presencePayload } = payload;
    expect(JSON.stringify(presencePayload)).not.toMatch(
      /terminal_output|raw_command|chat_content|prompt|filesystem|api_key|secret|user_id/i,
    );
  });

  it('fails closed before RPC for invalid device metadata', async () => {
    const rpc = vi.fn();

    await expect(
      publishDesktopPresence({ rpc }, accountA, {
        deviceId: '../outside',
        displayName: 'Laptop',
        appVersion: '1.5.0',
        terminals: [],
        chats: [],
        agentJobs: [],
        activeRuntime: null,
        providerUsage: {},
        backgroundTaskCount: 0,
        recentSyncAt: null,
      }),
    ).rejects.toThrow(/device/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('marks only the current device offline through the account-scoped RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });

    await expect(markDesktopPresenceOffline({ rpc }, accountA, 'device_12345678')).resolves.toBe(
      true,
    );
    expect(rpc).toHaveBeenCalledWith('mark_desktop_presence_offline', {
      p_expected_user_id: accountA,
      p_device_id: 'device_12345678',
    });
  });

  it('fails closed when a delayed publish reaches transport after the account changes', async () => {
    let currentUserId = accountA;
    let release: (() => void) | undefined;
    let wrotePresence = false;
    const rpc = vi.fn(async (_name: string, payload: Record<string, unknown>) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (payload.p_expected_user_id !== currentUserId) {
        return { data: null, error: { message: 'account changed' } };
      }
      wrotePresence = true;
      return { data: true, error: null };
    });

    const pending = publishDesktopPresence({ rpc }, accountA, {
      deviceId: 'device_12345678',
      displayName: 'Main PC',
      appVersion: '1.5.0',
      terminals: [],
      chats: [],
      agentJobs: [],
      activeRuntime: null,
      providerUsage: {},
      backgroundTaskCount: 0,
      recentSyncAt: null,
    });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    currentUserId = accountB;
    release?.();

    await expect(pending).rejects.toThrow(/unavailable/i);
    expect(wrotePresence).toBe(false);
  });

  it('fails closed when delayed offline cleanup reaches transport after the account changes', async () => {
    let currentUserId = accountA;
    let release: (() => void) | undefined;
    let markedOffline = false;
    const rpc = vi.fn(async (_name: string, payload: Record<string, unknown>) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (payload.p_expected_user_id !== currentUserId) {
        return { data: null, error: { message: 'account changed' } };
      }
      markedOffline = true;
      return { data: true, error: null };
    });

    const pending = markDesktopPresenceOffline({ rpc }, accountA, 'device_12345678');
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    currentUserId = accountB;
    release?.();

    await expect(pending).rejects.toThrow(/unavailable/i);
    expect(markedOffline).toBe(false);
  });

  it('normalizes unsafe status values instead of forwarding them', () => {
    const snapshot = sanitizeDesktopPresence({
      deviceId: 'device_12345678',
      displayName: 'Laptop',
      appVersion: '1.5.0',
      terminals: [{ id: 'pty_1', name: 'Terminal', status: 'raw command here' }],
      chats: [],
      agentJobs: [],
      activeRuntime: null,
      providerUsage: {},
      backgroundTaskCount: 0,
      recentSyncAt: null,
    });

    expect(snapshot.terminals[0]?.status).toBe('unknown');
  });
});
