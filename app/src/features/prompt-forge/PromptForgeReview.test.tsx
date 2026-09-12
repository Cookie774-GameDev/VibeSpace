import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createPromptForgeJob, transitionPromptForgeJob } from './contracts';
import { PromptForgeReview } from './PromptForgeReview';

function readyJob() {
  const initial = createPromptForgeJob({
    id: 'forge-review-1',
    accountId: 'account-1',
    chatId: 'chat-1',
    projectId: 'project-1',
    originalDraft: 'Build a runner game.',
    originalAttachments: [],
    modelSelection: { mode: 'prefer_local' },
    privacyMode: 'local_only',
    allowPublicResearch: false,
    now: 100,
  });
  const collecting = transitionPromptForgeJob(initial, {
    expectedRevision: 1,
    status: 'collecting_context',
    now: 101,
  });
  const generating = transitionPromptForgeJob(collecting, {
    expectedRevision: 2,
    status: 'generating',
    selectedSourceIds: [],
    retrievedSources: [],
    resolvedModel: {
      providerId: 'ollama',
      modelId: 'qwen3:8b',
      label: 'Qwen 3 8B',
      connectionId: 'ollama-local',
      connectionMode: 'local',
      local: true,
      billingClass: 'local_free',
    },
    now: 102,
  });
  const validating = transitionPromptForgeJob(generating, {
    expectedRevision: 3,
    status: 'validating',
    generatedDraft: 'Build a polished, accessible endless runner game.',
    usage: {
      inputTokens: 120,
      outputTokens: 40,
      costUsd: 0,
      finishReason: 'stop',
      startedAt: 103,
      completedAt: 104,
    },
    now: 104,
  });
  return transitionPromptForgeJob(validating, {
    expectedRevision: 4,
    status: 'ready',
    generatedDraft: 'Build a polished, accessible endless runner game.',
    validation: { passed: true, missingCount: 0, checkedAt: 105 },
    now: 105,
  });
}

describe('Prompt Forge inline review', () => {
  it('renders compactly inside the composer instead of opening a dialog', () => {
    render(
      <PromptForgeReview
        open
        compact
        job={readyJob()}
        onAccept={vi.fn()}
        onRegenerate={vi.fn()}
        onRegenerateWithInstructions={vi.fn()}
        onRestoreOriginal={vi.fn()}
        onReturnFocus={vi.fn()}
      />,
    );

    const review = screen.getByRole('region', { name: 'Prompt Forge inline review' });
    expect(review.getAttribute('data-compact')).toBe('true');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Upgraded prompt ready')).toBeTruthy();
    expect(screen.getByText(/Qwen 3 8B/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept upgraded prompt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry prompt upgrade' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add context to prompt upgrade' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore original prompt' })).toBeTruthy();
  });

  it('keeps accept, retry, contextual retry, and restore explicit', () => {
    const handlers = {
      onAccept: vi.fn(),
      onRegenerate: vi.fn(),
      onRegenerateWithInstructions: vi.fn(),
      onRestoreOriginal: vi.fn(),
      onReturnFocus: vi.fn(),
    };
    render(<PromptForgeReview open job={readyJob()} {...handlers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Accept upgraded prompt' }));
    expect(handlers.onAccept).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Retry prompt upgrade' }));
    expect(handlers.onRegenerate).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Add context to prompt upgrade' }));
    fireEvent.change(screen.getByLabelText('Additional prompt context'), {
      target: { value: 'Keep the result under 200 words.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply additional context' }));
    expect(handlers.onRegenerateWithInstructions).toHaveBeenCalledWith(
      'Keep the result under 200 words.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Restore original prompt' }));
    expect(handlers.onRestoreOriginal).toHaveBeenCalledOnce();
  });

  it('does not render when review is closed', () => {
    render(
      <PromptForgeReview
        open={false}
        job={readyJob()}
        onAccept={vi.fn()}
        onRegenerate={vi.fn()}
        onRegenerateWithInstructions={vi.fn()}
        onRestoreOriginal={vi.fn()}
        onReturnFocus={vi.fn()}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Prompt Forge inline review' })).toBeNull();
  });
});
