import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessRuntimeManager, HarnessRuntimeState } from '@/lib/harness';
import { HarnessReadinessGate, useHarnessRuntimeState } from './HarnessReadinessGate';

function manager(initial: HarnessRuntimeState) {
  let snapshot = initial;
  const subscribers = new Set<() => void>();
  const runtimeManager: HarnessRuntimeManager & {
    publish(next: HarnessRuntimeState): void;
  } = {
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    getSnapshot: () => snapshot,
    getConnection: () => undefined,
    refresh: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    publish(next) {
      snapshot = next;
      subscribers.forEach((listener) => listener());
    },
  };
  return runtimeManager;
}

afterEach(cleanup);

describe('HarnessReadinessGate', () => {
  it('shows the exact missing-runtime CTA and starts the explicit download', () => {
    const runtime = manager({ kind: 'download_required' });
    render(<HarnessReadinessGate manager={runtime} />);

    expect(screen.getByText('OpenCode Harness required')).toBeTruthy();
    expect(screen.getByText('Download the verified OpenCode harness to enable Chat.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download Harness' }));
    expect(runtime.download).toHaveBeenCalledTimes(1);
  });

  it('shows bounded progress and exposes cancellation', () => {
    const runtime = manager({ kind: 'downloading', progress: 0.42 });
    render(<HarnessReadinessGate manager={runtime} />);

    expect(screen.getByText('Downloading OpenCode Harness… 42%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(runtime.cancel).toHaveBeenCalledTimes(1);
  });

  it('renders verification, installation, repair, failure retry, and ready states', () => {
    const runtime = manager({ kind: 'verifying' });
    const view = render(<HarnessReadinessGate manager={runtime} />);
    expect(screen.getByText('Verifying OpenCode Harness…')).toBeTruthy();

    act(() => runtime.publish({ kind: 'installing' }));
    expect(screen.getByText('Installing OpenCode Harness…')).toBeTruthy();
    act(() => runtime.publish({ kind: 'incompatible', reason: 'Unsupported version.' }));
    expect(screen.getByText('OpenCode Harness needs repair')).toBeTruthy();
    expect(screen.getByText('Unsupported version.')).toBeTruthy();

    act(() =>
      runtime.publish({
        kind: 'failed',
        recoverable: true,
        message: 'Integrity verification failed.',
      }),
    );
    expect(screen.getByText('Integrity verification failed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Download' }));
    expect(runtime.download).toHaveBeenCalledTimes(1);

    act(() => runtime.publish({ kind: 'ready', source: 'managed', version: '1.18.16' }));
    expect(view.container.innerHTML).toBe('');
  });

  it('preserves a controlled draft across blocked to ready transitions', () => {
    const runtime = manager({ kind: 'download_required' });
    function DraftBoundary() {
      const state = useHarnessRuntimeState(runtime);
      const [draft, setDraft] = useState('keep this draft');
      return (
        <>
          <HarnessReadinessGate manager={runtime} />
          <textarea
            aria-label="Draft"
            value={draft}
            disabled={state.kind !== 'ready'}
            onChange={(event) => setDraft(event.target.value)}
          />
        </>
      );
    }
    render(<DraftBoundary />);
    const draft = screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement;
    expect(draft.disabled).toBe(true);
    expect(draft.value).toBe('keep this draft');

    act(() => runtime.publish({ kind: 'ready', source: 'managed', version: '1.18.16' }));
    expect(draft.disabled).toBe(false);
    expect(draft.value).toBe('keep this draft');
  });

  it('keeps Composer send and input paths guarded by runtime readiness', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/features/chat/Composer.tsx'), 'utf8');
    expect(source).toContain('const harnessRuntimeState = useHarnessRuntimeState();');
    expect(source).toContain("const harnessBlocked = harnessRuntimeState.kind !== 'ready';");
    expect(source).toContain('if (harnessBlocked) return false;');
    expect(source).toContain('disabled={harnessBlocked}');
    expect(source).toContain('<HarnessReadinessGate />');
    expect(source).toMatch(/const canSend =[\s\S]*!sending &&\s*!harnessBlocked;/);
  });
});
