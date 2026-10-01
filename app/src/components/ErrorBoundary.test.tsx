import * as React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syntheticCredentialFixture } from '@/test/syntheticCredentialFixture';
import { ErrorBoundary, sanitizeBoundaryError } from './ErrorBoundary';

const devConsoleLog = vi.hoisted(() => vi.fn());
const devConsoleSetOpen = vi.hoisted(() => vi.fn());

vi.mock('@/features/dev-console/store', () => ({
  devConsole: {
    log: devConsoleLog,
    setOpen: devConsoleSetOpen,
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  devConsoleLog.mockClear();
  devConsoleSetOpen.mockClear();
});

describe('ErrorBoundary crash containment', () => {
  it('contains the App at the renderer root rather than below early boot gates', () => {
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');

    expect(mainSource).toMatch(/<ErrorBoundary>\s*<App\s*\/>\s*<\/ErrorBoundary>/);
  });

  it('redacts and bounds exception details before returning them', () => {
    const secret = syntheticCredentialFixture('ghp_', 'SyntheticCredentialValue1234567890');
    const error = new Error(`Provider failed with ${secret}`);
    error.stack = `Error: Provider failed with ${secret}\n${'frame\n'.repeat(3_000)}`;

    const safe = sanitizeBoundaryError(error);

    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(safe.message).toContain('[redacted:token]');
    expect(safe.stack?.length ?? 0).toBeLessThanOrEqual(8_000);
  });

  it('renders a recoverable fallback without leaking raw exception data', async () => {
    const secret = syntheticCredentialFixture('ghp_', 'SyntheticCredentialValue1234567890');
    const clipboardWrite = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function Crash(): React.ReactNode {
      throw new Error(`Renderer failed with ${secret}`);
    }

    render(
      <ErrorBoundary>
        <Crash />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert').textContent).toContain('Something hit a snag');
    expect(screen.getByRole('alert').textContent).not.toContain(secret);
    expect(JSON.stringify(devConsoleLog.mock.calls)).not.toContain(secret);
    const ownedConsoleCall = consoleError.mock.calls.find(([message]) =>
      String(message).startsWith('[ErrorBoundary]'),
    );
    expect(JSON.stringify(ownedConsoleCall)).not.toContain(secret);
    expect(String(ownedConsoleCall?.[0])).toContain('[redacted:token]');

    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
    expect(String(clipboardWrite.mock.calls[0]?.[0])).not.toContain(secret);

    fireEvent.click(screen.getByRole('button', { name: 'Open dev console' }));
    expect(devConsoleSetOpen).toHaveBeenCalledWith(true);
  });
});
