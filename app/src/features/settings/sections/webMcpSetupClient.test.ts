import { afterEach, expect, it, vi } from 'vitest';
import { saveWebMcpDraft, validateSetupDraft } from './webMcpSetupClient';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
afterEach(() => invoke.mockReset());
const draft = {
  displayName: '',
  tunnelId: 'tunnel_123456789',
  guideTab: 'tunnel' as const,
  step: 1,
};
it('uses a default ChatGPT plugin label when the optional name is blank', async () => {
  expect(validateSetupDraft(draft, '')).toBeUndefined();
  invoke.mockImplementation(async (command) =>
    command === 'desktop_connector_status'
      ? { ...draft, displayName: 'VibeSpace Desktop', hasKey: false }
      : undefined,
  );
  await expect(saveWebMcpDraft(draft, '')).resolves.toMatchObject({
    displayName: 'VibeSpace Desktop',
  });
  expect(invoke).toHaveBeenCalledWith('desktop_connector_setup', {
    action: 'save',
    draft: { ...draft, displayName: 'VibeSpace Desktop' },
  });
});
it('reports secure-storage failure without blaming remote tunnel permissions', async () => {
  invoke.mockRejectedValue('CREDENTIAL_STORAGE_UNAVAILABLE');
  await expect(
    saveWebMcpDraft({ ...draft, displayName: 'Test' }, 'synthetic-test-runtime-key'),
  ).rejects.toThrow(/secure.*storage/i);
});
it('never includes arbitrary native error text or credentials in the displayed error', async () => {
  invoke.mockRejectedValue('unexpected diagnostic secret-marker-123');
  await expect(saveWebMcpDraft({ ...draft, displayName: 'Test' }, '')).rejects.not.toThrow(
    /secret-marker/,
  );
});

it('rejects an acknowledged save when current setup step is stale or absent in native readback', async () => {
  const requested = { ...draft, displayName: 'Synthetic plugin', step: 3 };
  for (const step of [1, undefined]) {
    invoke.mockImplementation(async (command) =>
      command === 'desktop_connector_status'
        ? { ...requested, step, hasKey: false }
        : undefined,
    );
    await expect(saveWebMcpDraft(requested, '')).rejects.toThrow(/saved and verified/i);
  }
});

it('accepts the exact acknowledged advanced setup step without claiming an active tunnel', async () => {
  const requested = { ...draft, displayName: 'Synthetic plugin', step: 3 };
  invoke.mockImplementation(async (command) =>
    command === 'desktop_connector_status'
      ? { ...requested, hasKey: false, connectionDetected: false, status: 'disconnected' }
      : undefined,
  );
  await expect(saveWebMcpDraft(requested, '')).resolves.toMatchObject({
    step: 3, connectionDetected: false, status: 'disconnected',
  });
});
