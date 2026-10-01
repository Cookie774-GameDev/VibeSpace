import { describe, expect, it, vi } from 'vitest';
import { getBuiltinAction } from './registry';
import { eventRepo } from '@/lib/db/repositories';
import { useAuthStore } from '@/stores/auth';
import type { WorkspaceId } from '@/types';

describe('schedule actions', () => {
  it.each(['request', 'account'] as const)('refuses the write when %s cancellation runs between the probe and outer continuation', async (cancelledOwner) => {
    const original = useAuthStore.getState();
    const request = new AbortController();
    const account = new AbortController();
    const signal = AbortSignal.any([request.signal, account.signal]);
    const write = vi.spyOn(eventRepo, 'create').mockImplementation(async () => {
      expect(signal.aborted).toBe(true);
      throw Error('write_was_admitted_after_abort');
    });
    useAuthStore.setState({ workspaceId: 'workspace-request' as WorkspaceId });
    try {
      await expect(getBuiltinAction('schedule.create')!.run({ title: 'QA only', prompt: 'QA only',
        startAtMs: Date.now() + 86400000, recurrence: 'once' }, {
          source: 'ai', signal,
          isRequestLive: () => {
            const probe = Promise.resolve(true);
            void probe.then(() => queueMicrotask(() => (cancelledOwner === 'request' ? request : account).abort()));
            return probe;
          },
        })).rejects.toMatchObject({ name: 'AbortError' });
      expect(write).not.toHaveBeenCalled();
      expect(cancelledOwner === 'request' ? account.signal.aborted : request.signal.aborted).toBe(false);
    } finally {
      write.mockRestore();
      useAuthStore.setState(original);
    }
  });
  it.each(['already ended', 'ended during final native probe'])('does not start a schedule write when the request %s', async (stage) => {
    const original = useAuthStore.getState();
    const write = vi.spyOn(eventRepo, 'create').mockRejectedValue(Error('write_was_admitted'));
    const request = new AbortController();
    useAuthStore.setState({ workspaceId: 'workspace-request' as WorkspaceId });
    if (stage === 'already ended') request.abort();
    try {
      await expect(getBuiltinAction('schedule.create')!.run({ title: 'QA only', prompt: 'QA only',
        startAtMs: Date.now() + 86400000, recurrence: 'once' }, {
          source: 'ai', signal: request.signal,
          isRequestLive: async () => { request.abort(); return true; },
        })).rejects.toMatchObject({ name: 'AbortError' });
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      useAuthStore.setState(original);
    }
  });
  it('registers Jarvis schedule command actions', () => {
    expect(getBuiltinAction('schedule.create')?.category).toBe('schedule');
    expect(getBuiltinAction('schedule.list')?.category).toBe('schedule');
    expect(getBuiltinAction('schedule.pause')?.category).toBe('schedule');
    expect(getBuiltinAction('schedule.resume')?.category).toBe('schedule');
    expect(getBuiltinAction('schedule.delete')?.category).toBe('schedule');
    expect(getBuiltinAction('schedule.history')?.category).toBe('schedule');
  });

  it('marks destructive schedule actions as approval-gated', () => {
    expect(getBuiltinAction('schedule.delete')?.destructive).toBe(true);
    expect(getBuiltinAction('schedule.pause')?.destructive).toBe(true);
  });
});
