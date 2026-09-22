import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalPeerFabricCommandPort,
  recoverTerminalPeerFabricTeam,
  TERMINAL_PEER_FABRIC_TOOL,
} from './terminalPeerFabricTool';

describe('Terminal Peer Fabric preloaded tool', () => {
  it('recovers ten members but rejects an eleventh before native invocation', async () => {
    const port = {
      capability: vi
        .fn()
        .mockResolvedValue({ available: true, version: '2.0.0', operations: ['connect'] }),
      connect: vi.fn().mockResolvedValue({ status: 'completed' }),
      command: vi.fn(),
    };
    const peers = Array.from({ length: 10 }, (_, i) => ({
      paneId: `p-${i}`,
      sessionId: `s-${i}`,
      projectId: 'proj',
      runtimeGeneration: 'gen',
    }));
    await expect(recoverTerminalPeerFabricTeam('ten', peers, port)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(
      recoverTerminalPeerFabricTeam(
        'eleven',
        [...peers, { ...peers[0], paneId: 'p-10', sessionId: 's-10' }],
        port,
      ),
    ).rejects.toThrow();
    expect(port.connect).toHaveBeenCalledTimes(1);
  });
  it('is bundled as a preloaded tool with no install or download action', () => {
    expect(TERMINAL_PEER_FABRIC_TOOL).toMatchObject({
      id: 'terminal-peer-fabric',
      name: 'Terminal Peer Fabric',
      distribution: 'preloaded',
    });
    expect(TERMINAL_PEER_FABRIC_TOOL.actions).toEqual(['inspect', 'open']);
  });

  it('fails closed when the native capability is absent', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('unknown command'));
    const port = createTerminalPeerFabricCommandPort(invoke);

    await expect(port.capability()).resolves.toEqual({ available: false });
    await expect(
      port.command({ commandId: 'team.status', correlationId: 'corr-1', targetIds: [] }),
    ).rejects.toThrow(/unavailable/i);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('accepts only compatible versioned native capabilities', async () => {
    const invoke = vi.fn().mockResolvedValue({
      available: true,
      version: '2.2.0',
      operations: ['connect', 'team.status'],
    });
    const port = createTerminalPeerFabricCommandPort(invoke);

    await expect(port.capability()).resolves.toEqual({
      available: true,
      version: '2.2.0',
      operations: ['connect', 'team.status'],
    });
  });

  it('does not advertise a versioned endpoint that cannot connect a team', async () => {
    const invoke = vi.fn().mockResolvedValue({ available: true, version: '2.2.0' });
    const port = createTerminalPeerFabricCommandPort(invoke);

    await expect(port.capability()).resolves.toEqual({ available: false });
  });

  it('rejects legacy capabilities and preserves stored delivery truth', async () => {
    const legacy = createTerminalPeerFabricCommandPort(
      vi.fn().mockResolvedValue({
        available: true,
        version: '1.9.9',
        operations: ['connect', 'team.status'],
      }),
    );
    await expect(legacy.capability()).resolves.toEqual({ available: false });

    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        available: true,
        version: '2.0.0',
        operations: ['connect', 'team.status'],
      })
      .mockResolvedValueOnce({ correlationId: 'corr-2', status: 'stored', targetIds: ['sess-1'] });
    const port = createTerminalPeerFabricCommandPort(invoke);
    await expect(
      port.command({ commandId: 'team.status', correlationId: 'corr-2', targetIds: ['sess-1'] }),
    ).resolves.toEqual({ correlationId: 'corr-2', status: 'stored', targetIds: ['sess-1'] });
  });

  it('recovers after restart only by reconnecting verified stable peer generations', async () => {
    const port = {
      capability: vi.fn().mockResolvedValue({
        available: true,
        version: '2.0.0',
        operations: ['connect', 'team.status'],
      }),
      connect: vi.fn().mockResolvedValue({
        correlationId: 'recovery-1',
        status: 'completed',
        targetIds: ['sess-1', 'sess-2'],
      }),
      command: vi.fn(),
    };
    const peerRefs = [
      { paneId: 'pane-1', sessionId: 'sess-1', projectId: 'proj', runtimeGeneration: 'gen-1' },
      { paneId: 'pane-2', sessionId: 'sess-2', projectId: 'proj', runtimeGeneration: 'gen-2' },
    ];
    await expect(
      recoverTerminalPeerFabricTeam('recovery-1', peerRefs, port),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(port.connect).toHaveBeenCalledWith({ correlationId: 'recovery-1', peerRefs });
  });
});
