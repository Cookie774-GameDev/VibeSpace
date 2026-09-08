import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canInstallStartupUpdate } from './updateStartupPolicy';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), getState: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/stores/agents', () => ({ useAgentStore: { getState: mocks.getState } }));
describe('startup update restart policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getState.mockReturnValue({ runStates: {} });
  });
  afterEach(() => vi.useRealTimers());
  it('allows an idle workspace', async () => {
    mocks.invoke.mockResolvedValue([]);
    expect(await canInstallStartupUpdate()).toBe(true);
  });
  it.each([[{ sessionId: 'live-shell' }], null])(
    'preserves live or unknown terminals: %j',
    async (sessions) => {
      mocks.invoke.mockResolvedValue(sessions);
      expect(await canInstallStartupUpdate()).toBe(false);
    },
  );
  it('preserves queued and waiting agents', async () => {
    mocks.invoke.mockResolvedValue([]);
    for (const state of ['queued', 'thinking', 'streaming', 'waiting_for_user']) {
      mocks.getState.mockReturnValue({ runStates: { agent: state } });
      expect(await canInstallStartupUpdate()).toBe(false);
    }
  });
  it('defers if native inspection hangs', async () => {
    vi.useFakeTimers();
    mocks.invoke.mockReturnValue(new Promise(() => {}));
    const pending = canInstallStartupUpdate();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
