import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexRuntimeManager, CodexRuntimeState } from '@/lib/harness/codexRuntimeManager';
import { CodexReadinessGate } from './CodexReadinessGate';

function manager(initial: CodexRuntimeState) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    refresh: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    publish(next: CodexRuntimeState) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  } satisfies CodexRuntimeManager & { publish(next: CodexRuntimeState): void };
}

afterEach(cleanup);

describe('CodexReadinessGate', () => {
  it('requires an explicit install action and never requests credentials', () => {
    const runtime = manager({ kind: 'missing' });
    render(<CodexReadinessGate manager={runtime} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install Codex tools' }));
    expect(runtime.install).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toMatch(/api.?key|credential|token/iu);
  });

  it('does not require OpenCodex for the official OpenAI Codex route', () => {
    const runtime = manager({
      kind: 'ready',
      codexVersion: '0.151.0',
      openCodexVersion: '',
      translationRuntime: 'missing',
      executableId: 'cli-executable-1',
    });
    const view = render(<CodexReadinessGate manager={runtime} requiresTranslation={false} />);
    expect(view.container.innerHTML).toBe('');
  });

  it('requires the translator explicitly for a nonofficial Codex route', () => {
    const runtime = manager({
      kind: 'ready',
      codexVersion: '0.151.0',
      openCodexVersion: '',
      translationRuntime: 'missing',
      executableId: 'cli-executable-1',
    });
    render(<CodexReadinessGate manager={runtime} requiresTranslation />);
    expect(screen.getByText('OpenCodex translation required')).toBeTruthy();
    expect(screen.getByText(/Official OpenAI Codex does not require it/iu)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Install OpenCodex translation' }));
    expect(runtime.install).toHaveBeenCalledWith({ includeTranslation: true });
  });

  it('shows truthful component progress and cancellation', () => {
    const runtime = manager({ kind: 'installing', component: 'opencodex', progress: 0.64 });
    render(<CodexReadinessGate manager={runtime} />);
    expect(screen.getByText('Installing OpenCodex… 64%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('64');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel installation' }));
    expect(runtime.cancel).toHaveBeenCalledOnce();
  });

  it('shows connection setup without presenting a false zero-percent download', () => {
    const runtime = manager({ kind: 'connecting', component: 'codex' });
    render(<CodexReadinessGate manager={runtime} />);
    expect(screen.getByText('Connecting to Codex downloads…')).toBeTruthy();
    expect(screen.queryByText(/0%/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel installation' }));
    expect(runtime.cancel).toHaveBeenCalledOnce();
  });

  it('supports contained failure retry and disappears only when both tools are verified', () => {
    const runtime = manager({
      kind: 'failed',
      recoverable: true,
      message: 'Install failed safely.',
    });
    const view = render(<CodexReadinessGate manager={runtime} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry installation' }));
    expect(runtime.install).toHaveBeenCalledOnce();
    act(() =>
      runtime.publish({
        kind: 'ready',
        codexVersion: '0.151.0',
        openCodexVersion: '5.0.0',
        executableId: 'cli-executable-1',
      }),
    );
    expect(view.container.innerHTML).toBe('');
  });
});
