import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CaoChatControls } from './CaoChatControls';
import { useJarvisLearningStore } from './learningStore';
import { CAO_GUIDANCE_AREAS, parseCaoGuidance } from './caoGuidance';
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));
vi.mock('./caoChatControlProduction', () => ({
  caoPermissionKey: (id: string) => id,
  setCaoChatPermission: vi.fn(),
  caoChatControl: { reject: vi.fn() },
}));
beforeEach(() => {
  const state = useJarvisLearningStore.getState();
  state.clearForTests();
  state.setAccount('account');
});
it('keeps activation unavailable while the learned section is incomplete', () => {
  render(<CaoChatControls />);
  expect((screen.getByLabelText('Enable CAO') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByLabelText('CAO learning readiness').textContent).toContain('fileHandling');
  expect(
    (screen.getByRole('button', { name: 'Prepare message' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it('makes activation available after learning, but leaves it off until the user chooses', () => {
  useJarvisLearningStore.getState().updateCaoGuidance(
    parseCaoGuidance(
      JSON.stringify({
        sections: Object.fromEntries(
          CAO_GUIDANCE_AREAS.map((area) => [
            area,
            {
              guidance: 'Use focused messages and verify observed results before claiming success.',
              sourceIds: ['message'],
            },
          ]),
        ),
      }),
      ['message'],
    ),
  );
  render(<CaoChatControls />);
  const enable = screen.getByLabelText('Enable CAO') as HTMLInputElement;
  expect(enable.disabled).toBe(false);
  expect(enable.checked).toBe(false);
  expect((screen.getByLabelText('CAO message permissions') as HTMLSelectElement).value).toBe(
    'approve-before-send',
  );
});
