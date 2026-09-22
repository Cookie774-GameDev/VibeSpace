import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useCaoSetupDraft } from './missionDraft';
it('retains the objective, step and selected team after unmount without crossing project scopes', () => {
  const scope = { accountId: 'draft-test', workspaceId: 'w', projectId: 'p' };
  const first = renderHook(() => useCaoSetupDraft(scope));
  act(() => {
    first.result.current.update('objective', 'Build the real game');
    first.result.current.update('step', 3);
    first.result.current.update('targets', ['chat:one']);
  });
  first.unmount();
  const resumed = renderHook(() => useCaoSetupDraft(scope));
  expect(resumed.result.current.draft).toMatchObject({
    objective: 'Build the real game',
    step: 3,
    targets: ['chat:one'],
  });
  const other = renderHook(() => useCaoSetupDraft({ ...scope, projectId: 'other' }));
  expect(other.result.current.draft.objective).toBe('');
});
