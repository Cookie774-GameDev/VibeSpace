import { expect, it } from 'vitest';
import { projectNativeTaskActivity, readNativeTaskActivity } from './openCodeNativeActivity';

it('retains the OpenCode task identity, actual model, terminal result and native reply route', () => {
  expect(
    projectNativeTaskActivity('task', {
      status: 'completed',
      input: { description: 'Review layout' },
      metadata: { sessionId: 'ses_child', model: { providerID: 'openai', modelID: 'gpt-child' } },
      output: 'Layout review complete.',
    }),
  ).toMatchObject({
    name: 'Review layout',
    sessionId: 'ses_child',
    harness: 'opencode',
    modelLabel: 'openai/gpt-child',
    status: 'done',
    result: 'Layout review complete.',
  });
});

it('keeps failed tasks failed and never infers their model from the parent', () => {
  expect(
    projectNativeTaskActivity('task', {
      status: 'error',
      error: 'Child disconnected',
      metadata: { sessionID: 'ses_child' },
    }),
  ).toMatchObject({ status: 'error', error: 'Child disconnected' });
  expect(
    projectNativeTaskActivity('task', { status: 'running', input: { prompt: 'Private task' } })
      ?.modelLabel,
  ).toBeUndefined();
});

it('revalidates persisted native control metadata and bounds terminal text', () => {
  const restored = readNativeTaskActivity({
    name: 'Review',
    sessionId: '../other',
    parentSessionId: 'thr_parent',
    harness: 'fabricated',
    reasoningEffort: 'high',
    result: 'x'.repeat(100_000),
  });
  expect(restored?.sessionId).toBeUndefined();
  expect(restored?.harness).toBeUndefined();
  expect(restored?.result?.length).toBeLessThanOrEqual(8192);
});
