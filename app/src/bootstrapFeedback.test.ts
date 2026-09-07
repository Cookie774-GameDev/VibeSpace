import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountWithFeedback } from './bootstrapFeedback';

afterEach(() => document.body.replaceChildren());

describe('native app bootstrap feedback', () => {
  it('shows a loading status while modules load and lets the real app replace it', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    let finish!: () => void;
    const pending = mountWithFeedback(
      root,
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            root.textContent = 'App ready';
            resolve();
          };
        }),
      vi.fn(),
    );
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Opening VibeSpace');
    finish();
    await pending;
    expect(root.textContent).toBe('App ready');
  });

  it('offers retry when bootstrap fails without displaying raw exception data', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const retry = vi.fn();
    await mountWithFeedback(
      root,
      async () => {
        throw new Error('private-detail');
      },
      retry,
    );
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    expect(root.textContent).not.toContain('private-detail');
    root.querySelector('button')?.click();
    expect(retry).toHaveBeenCalledOnce();
  });
});
