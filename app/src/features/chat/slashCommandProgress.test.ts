import { describe, expect, it, vi } from 'vitest';
import { runSlashCommandWithProgress } from './slashCommandProgress';

describe('local slash command progress', () => {
  it('shows running immediately and completes only after execution', async () => {
    let finish!: (value: boolean) => void;
    const update = vi.fn();
    const pending = runSlashCommandWithProgress('doctor', () => new Promise<boolean>(resolve => { finish = resolve; }), update);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'running' }));
    finish(true);
    await expect(pending).resolves.toBe(true);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'succeeded' }));
  });

  it.each(['Error', 'AbortError'])('finishes %s without forwarding to a model or exposing private errors', async name => {
    const update = vi.fn();
    const error = new Error('private token');
    error.name = name;
    await expect(runSlashCommandWithProgress('usage', async () => { throw error; }, update)).resolves.toBe(true);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ phase: name === 'AbortError' ? 'cancelled' : 'failed' }));
    expect(JSON.stringify(update.mock.calls)).not.toContain('private token');
  });

  it('does not claim completion when a command forwards to a provider', async () => {
    const update = vi.fn();
    await expect(runSlashCommandWithProgress('plan', async () => 'make a plan', update)).resolves.toBe('make a plan');
    expect(update).toHaveBeenLastCalledWith(null);
  });

  it('preserves an attention-needed Doctor result', async () => {
    const update = vi.fn();
    await runSlashCommandWithProgress('doctor', async () => true, update, () => ({ phase: 'failed', detail: 'Attention needed; see the diagnostic report.' }));
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'failed', detail: 'Attention needed; see the diagnostic report.' }));
  });
});
