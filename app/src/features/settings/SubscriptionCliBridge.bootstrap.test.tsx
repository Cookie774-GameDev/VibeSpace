import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HarnessRuntimeManager, OpenCodeServerConnection } from '@/lib/harness/runtimeManager';
import type { HarnessRuntimeState } from '@/lib/harness/types';
import type { OpenCodeSubscriptionClient } from '@/lib/harness/subscriptionBridge';
import { SubscriptionCliBridge } from './sections/SubscriptionCliBridge';

const fixture = vi.hoisted(() => {
  let snapshot: HarnessRuntimeState = { kind: 'download_required' };
  let connection: OpenCodeServerConnection | undefined;
  const listeners = new Set<() => void>();
  const client: OpenCodeSubscriptionClient = {
    providerAuthMethods: vi.fn(async () => ({ openai: [{ type: 'oauth' as const, label: 'ChatGPT Plus/Pro' }] })),
    providerStatus: vi.fn(async () => ({ connected: [] })),
    configProviders: vi.fn(async () => ({})),
    authorizeProvider: vi.fn(async () => { throw new Error('Authorization requires an explicit click'); }),
    callbackProvider: vi.fn(async () => true),
  };
  const manager: HarnessRuntimeManager = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    getConnection: () => connection,
    refresh: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    repair: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  };
  return {
    manager, client,
    createClient: vi.fn(() => client),
    publish(next: HarnessRuntimeState, nextConnection?: OpenCodeServerConnection) {
      snapshot = next; connection = nextConnection; listeners.forEach((listener) => listener());
    },
  };
});
vi.mock('@/lib/harness/runtimeManager', () => ({ harnessRuntimeManager: fixture.manager }));
vi.mock('@/lib/harness/openCodeClient', () => ({ createOpenCodeHttpClient: fixture.createClient }));
vi.mock('@/lib/ai/adapters/autoDetectConnections', () => ({
  ensureExternalConnectionAutoDetection: vi.fn(async () => ({})),
  refreshExternalConnectionAutoDetection: vi.fn(async () => ({})),
}));
vi.mock('@/lib/ai/adapters/opencodePersistent', () => ({
  openCodePersistentAdapter: { id: 'opencode-cli', detect: vi.fn(), probeAuth: vi.fn() },
  invalidateOpenCodePersistentCaches: vi.fn(),
}));
vi.mock('@/lib/ai/useAccessibleChatModels', () => ({ requestOpenCodeModelCatalogRefresh: vi.fn() }));
vi.mock('@/features/terminals/terminalCommandQueue', () => ({ enqueueTerminalCommandBatch: vi.fn() }));
vi.mock('@/lib/tauri', () => ({ openExternal: vi.fn() }));
vi.mock('./sections/McpConnections', () => ({ McpConnections: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  fixture.publish({ kind: 'download_required' });
});
afterEach(cleanup);

it('offers verified runtime setup from AI Connectors without starting installation or provider login implicitly', () => {
  render(<SubscriptionCliBridge autoDetect={false} records={{}} />);
  expect(screen.getByRole('button', { name: 'Download Harness' })).toBeTruthy();
  expect(fixture.manager.download).not.toHaveBeenCalled();
  expect(fixture.createClient).not.toHaveBeenCalled();
  expect(fixture.client.authorizeProvider).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Download Harness' }));
  expect(fixture.manager.download).toHaveBeenCalledOnce();
});

it('keeps bootstrap progress, cancellation and offline retry in the same connector path without premature discovery', () => {
  render(<SubscriptionCliBridge autoDetect={false} records={{}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download Harness' }));
  act(() => fixture.publish({ kind: 'downloading', progress: 0.25 }));
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(fixture.manager.cancel).toHaveBeenCalledOnce();
  act(() => fixture.publish({ kind: 'failed', recoverable: true, message: 'Download unavailable offline.' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry Download' }));
  expect(fixture.manager.download).toHaveBeenCalledTimes(2);
  expect(fixture.createClient).not.toHaveBeenCalled();
  expect(fixture.client.authorizeProvider).not.toHaveBeenCalled();
});

it('hands only the validated ready connection to subscription discovery and leaves authorization explicit', async () => {
  render(<SubscriptionCliBridge autoDetect={false} records={{}} />);
  const connection: OpenCodeServerConnection = {
    version: '1.18.18', source: 'managed', generation: 'opencode-server-bootstrap-fixture',
  };
  act(() => fixture.publish({ kind: 'ready', source: 'managed', version: connection.version }, connection));
  await waitFor(() => expect(fixture.createClient).toHaveBeenCalledWith(connection));
  expect(await screen.findByRole('button', { name: 'Connect OpenAI with ChatGPT Plus/Pro' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Download Harness' })).toBeNull();
  expect(fixture.client.authorizeProvider).not.toHaveBeenCalled();
  expect(fixture.client.callbackProvider).not.toHaveBeenCalled();
});
