import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KernelClientResponseEvent } from './kernelBridgeProtocol';
const transport = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), handlers: [] as Array<(e: { payload: KernelClientResponseEvent }) => void> }));
const local = vi.hoisted(() => ({ request: vi.fn(() => null as Promise<unknown> | null) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: transport.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: transport.listen.mockImplementation(async (_name, callback) => { transport.handlers.push(callback); return vi.fn(); }) }));
vi.mock('./kernelHost', () => ({ requestLocalJarvisKernelHost: local.request }));
import { createJarvisKernelClient } from './kernelClient';
const input = { accountId: 'account', chatId: 'chat', mapId: 'map' };
const response = { kind: 'context_source_revision' as const, version: 1 as const, ...input, workspaceId: 'workspace', projectId: 'project', worktreeHash: 'sha256:' + 'a'.repeat(64), sourceRevision: 'sha256:' + 'b'.repeat(64), authorityEpoch: 1 };
function emit(epoch: number, requestId: string) {
  for (const handler of transport.handlers) handler({ payload: { epoch, requestId, response } });
}
describe('source metadata from validated native broker generation', () => {
  beforeEach(() => { transport.invoke.mockReset(); transport.handlers.length = 0; local.request.mockReset(); Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} }); });
  afterEach(() => { delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });
  it('stamps the exact registered broker epoch without changing closed host DTO', async () => {
    transport.invoke.mockResolvedValue({ epoch: 7, requestId: 'request-7', deadlineMs: Date.now() + 1000 });
    const client = createJarvisKernelClient(); const pending = client.getContextSourceRevision(input);
    await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledOnce()); emit(7, 'request-7');
    expect(await pending).toEqual({ ...response, nativeHostEpoch: 7 }); expect(local.request).not.toHaveBeenCalled(); client.dispose();
  });
  it('ignores wrong epoch and request before accepting exact envelope', async () => {
    transport.invoke.mockResolvedValue({ epoch: 8, requestId: 'request-8', deadlineMs: Date.now() + 1000 });
    const client = createJarvisKernelClient(); let settled = false;
    const pending = client.getContextSourceRevision(input).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledOnce()); emit(7, 'request-8'); emit(8, 'wrong');
    await Promise.resolve(); expect(settled).toBe(false); emit(8, 'request-8');
    expect(await pending).toMatchObject({ nativeHostEpoch: 8 }); client.dispose();
  });
  it('exposes host replacement even when source and scope epoch are unchanged', async () => {
    transport.invoke.mockResolvedValueOnce({ epoch: 9, requestId: 'first', deadlineMs: Date.now() + 1000 }).mockResolvedValueOnce({ epoch: 10, requestId: 'second', deadlineMs: Date.now() + 1000 });
    const client = createJarvisKernelClient(); const first = client.getContextSourceRevision(input);
    await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledTimes(1)); emit(9, 'first'); const before = await first;
    const second = client.getContextSourceRevision(input); await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledTimes(2)); emit(9, 'second'); emit(10, 'second'); const after = await second;
    expect(before.kind).toBe('context_source_revision'); expect(after.kind).toBe('context_source_revision');
    if (before.kind !== 'context_source_revision' || after.kind !== 'context_source_revision') throw new Error('Expected protected source response');
    expect(before.sourceRevision).toBe(after.sourceRevision); expect(before.authorityEpoch).toBe(after.authorityEpoch); expect(before.nativeHostEpoch).not.toBe(after.nativeHostEpoch); client.dispose();
  });
  it('fails closed without native generation and never invokes local shortcut', async () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    local.request.mockResolvedValue(response); const client = createJarvisKernelClient();
    expect(await client.getContextSourceRevision(input)).toMatchObject({ kind: 'unavailable', reason: 'host_unavailable' });
    expect(local.request).not.toHaveBeenCalled(); expect(transport.invoke).not.toHaveBeenCalled(); client.dispose();
  });
});