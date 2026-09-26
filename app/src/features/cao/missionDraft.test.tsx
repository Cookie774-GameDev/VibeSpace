import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { caoDraftKey, readCaoDraft, useCaoSetupDraft } from './missionDraft';
it('retains the objective, step, coordinator and selected team after unmount without crossing project scopes', () => {
  const scope = { accountId: 'draft-test', workspaceId: 'w', projectId: 'p' };
  const choice = {
    backend: 'codex',
    providerId: 'openai',
    connectionId: 'openai-codex',
    modelId: 'gpt-5.6-luna',
    reasoningEffort: 'low',
  } as const;
  const first = renderHook(() => useCaoSetupDraft(scope));
  act(() => {
    first.result.current.update('objective', 'Build the real game');
    first.result.current.update('step', 3);
    first.result.current.update('targets', ['chat:one']);
    first.result.current.update('choice', choice);
  });
  first.unmount();
  const resumed = renderHook(() => useCaoSetupDraft(scope));
  expect(resumed.result.current.draft).toMatchObject({
    objective: 'Build the real game',
    step: 3,
    targets: ['chat:one'],
    choice,
  });
  const other = renderHook(() => useCaoSetupDraft({ ...scope, projectId: 'other' }));
  expect(other.result.current.draft.objective).toBe('');
});

it('hydrates the selected coordinator from session storage after a full app reload', () => {
  const scope = { accountId: 'draft-reload', workspaceId: 'w', projectId: 'p' };
  const choice = {
    backend: 'codex',
    providerId: 'openai',
    connectionId: 'openai-codex',
    modelId: 'gpt-5.6-luna',
    reasoningEffort: 'low',
  } as const;
  sessionStorage.setItem(
    caoDraftKey(scope),
    JSON.stringify({
      objective: 'Continue the existing mission',
      step: 4,
      targets: ['chat:one'],
      editing: false,
      choice,
    }),
  );

  const resumed = renderHook(() => useCaoSetupDraft(scope));

  expect(resumed.result.current.draft).toMatchObject({
    objective: 'Continue the existing mission',
    step: 4,
    targets: ['chat:one'],
    choice,
  });
});

it('treats legacy draft choices without profile provenance as unmarked', () => {
  const scope = { accountId: 'draft-legacy-choice', workspaceId: 'w', projectId: 'p' };
  const choice = {
    backend: 'opencode',
    providerId: 'alibaba',
    connectionId: 'opencode-cli',
    modelId: 'deepseek-v4-flash-0731',
    reasoningEffort: 'high',
  } as const;
  sessionStorage.setItem(
    caoDraftKey(scope),
    JSON.stringify({
      objective: 'Resume old setup',
      step: 1,
      targets: [],
      editing: false,
      choice,
    }),
  );

  expect(readCaoDraft(caoDraftKey(scope))).toMatchObject({
    choice,
    choiceExplicit: false,
    choiceProfileUpdatedAt: null,
  });
});
