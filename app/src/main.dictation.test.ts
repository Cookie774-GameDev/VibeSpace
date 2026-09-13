import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ mount: vi.fn(), workspace: vi.fn() }));
vi.mock('./bootstrapDictation', () => ({ mountDictation: mocks.mount }));
vi.mock('./bootstrapFeedback', () => ({ mountWithFeedback: mocks.workspace }));
afterEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
});
it('boots the dictation window without loading workspace feedback or the main app', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  history.replaceState(null, '', '/index.html?view=dictation');
  await import('./main');
  await waitFor(() => expect(mocks.mount).toHaveBeenCalledOnce());
  expect(mocks.workspace).not.toHaveBeenCalled();
});
