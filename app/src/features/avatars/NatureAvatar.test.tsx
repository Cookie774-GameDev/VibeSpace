import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../../../public/relay-avatars/nature/manifest.json';
import { NatureAvatar } from './NatureAvatar';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('NatureAvatar', () => {
  it('plays exactly one arrival reaction when a fresh message bubble mounts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => manifest }));
    const view = render(<NatureAvatar identity="nature-arrival-test" reactOnMount size={32} />);
    await waitFor(() => expect(view.container.querySelector('[data-avatar-ready="true"]')).not.toBeNull());
    const avatar = view.container.querySelector<HTMLElement>('[data-nature-avatar]')!;
    await waitFor(() => expect(Number(avatar.dataset.frame)).toBeGreaterThan(0));
    await waitFor(() => expect(avatar.dataset.frame).toBe('0'), { timeout: 3000 });
  });

  it('plays a newly delivered message and returns to the neutral portrait', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => manifest }));
    const view = render(<NatureAvatar identity="nature-reaction-test" reactionKey="historical" size={32} />);
    await waitFor(() => expect(view.container.querySelector('[data-avatar-ready="true"]')).not.toBeNull());
    const avatar = view.container.querySelector<HTMLElement>('[data-nature-avatar]')!;
    expect(avatar.dataset.frame).toBe('0');

    vi.useFakeTimers();
    view.rerender(<NatureAvatar identity="nature-reaction-test" reactionKey="new-message" size={32} />);
    await act(async () => { vi.advanceTimersByTime(350); });
    expect(Number(avatar.dataset.frame)).toBeGreaterThan(0);
    await act(async () => { vi.advanceTimersByTime(1800); });
    expect(avatar.dataset.frame).toBe('0');
  });
});
