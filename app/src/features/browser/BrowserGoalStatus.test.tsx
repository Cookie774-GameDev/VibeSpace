import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BrowserGoalStatus } from './BrowserGoalStatus';
import { createBrowserGoalStore, type BrowserGoalChatSnapshot } from './browserGoalStore';
import type { BrowserGoalChatRuntime } from './browserGoalChatRuntime';
import { useBrowserStore } from './browserStore';

function snapshot(patch: Partial<BrowserGoalChatSnapshot> = {}): BrowserGoalChatSnapshot {
  return {
    schemaVersion: 1,
    chatId: 'chat-1',
    goalId: 'goal-1',
    accountId: 'account-1',
    projectId: 'project-1',
    runId: 'run-1',
    objective: 'Complete the reviewed browser workflow.',
    state: 'active',
    tokenMode: 'token-saver',
    providerId: 'openai',
    modelId: 'gpt-5',
    completedActions: 1,
    totalActions: 3,
    checkpointSequence: 2,
    checkpointState: 'running',
    checkpointCreatedAt: 1_000,
    cursorExpiresAt: 10_000,
    currentOrigin: 'https://example.test',
    nextAction: { kind: 'browser.click', summary: 'Click Continue.' },
    evidenceRefs: ['jlive_browser_1'],
    providerArtifactRefs: ['jresult_provider_1'],
    ...patch,
  };
}

function runtimeHarness() {
  const pause = vi.fn(async () => snapshot({ state: 'paused' }));
  const cancel = vi.fn(async () => snapshot({ state: 'cancelled' }));
  const resume = vi.fn(async () => snapshot({ state: 'active' }));
  return {
    runtime: { pause, cancel, resume } as unknown as BrowserGoalChatRuntime,
    pause,
    cancel,
    resume,
  };
}

describe('BrowserGoalStatus', () => {
  it('shows compact truthful progress and expands checkpoint, origin, evidence and artifacts', () => {
    const store = createBrowserGoalStore();
    const harness = runtimeHarness();
    store.publish(snapshot());
    useBrowserStore.setState({ agentActions: [] });
    render(<BrowserGoalStatus chatId="chat-1" store={store} runtime={harness.runtime} />);

    expect(screen.getByText('1/3 actions · Token Saver')).toBeTruthy();
    expect(screen.getByText('Next: Click Continue.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText('https://example.test')).toBeTruthy();
    expect(screen.getByText('1 canonical reference(s)')).toBeTruthy();
    expect(screen.getByText('1 untrusted reference(s)')).toBeTruthy();
    expect(screen.getByText('openai / gpt-5')).toBeTruthy();
  });

  it('surfaces the exact pending approval and routes controls without browser execution', async () => {
    const store = createBrowserGoalStore();
    const harness = runtimeHarness();
    store.publish(snapshot({ approval: { reviewId: 'review-1', risk: 'confirm' } }));
    useBrowserStore.setState({ agentActions: [] });
    render(<BrowserGoalStatus chatId="chat-1" store={store} runtime={harness.runtime} />);

    expect(screen.getByText('Approval needed · confirm · review-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(harness.pause).toHaveBeenCalledWith('chat-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(harness.cancel).toHaveBeenCalledWith('chat-1'));
  });

  it('keeps resume available when recovery authority can be retried', async () => {
    const store = createBrowserGoalStore();
    const harness = runtimeHarness();
    store.publish(
      snapshot({
        state: 'recovery_unavailable',
        failureReason: 'Browser goal recovery authority is unavailable.',
      }),
    );
    useBrowserStore.setState({ agentActions: [] });
    render(<BrowserGoalStatus chatId="chat-1" store={store} runtime={harness.runtime} />);

    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(harness.resume).toHaveBeenCalledWith('chat-1'));
  });
});
