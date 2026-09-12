import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLaunchPlan, type OpenInTerminalRuntime } from './openInTerminal';
import { OpenInTerminalDialog } from './OpenInTerminalDialog';

function runtimeFixture(available = true): OpenInTerminalRuntime {
  const sessions = [
    { id: 'existing-active', status: 'running' as const, lastActiveAt: Date.now() },
    { id: 'existing-idle', status: 'detached' as const, lastActiveAt: 0 },
  ];
  return {
    detect: vi.fn(async () => ({
      available: available
        ? [
            {
              id: 'opencode' as const,
              name: 'OpenCode',
              executable: 'opencode',
              setup: 'Install OpenCode.',
              setupUrl: 'https://opencode.ai/docs',
              executablePath: 'C:\\Tools\\opencode.exe',
            },
          ]
        : [],
      unavailable: [],
    })),
    inspect: vi.fn(async () => sessions),
    launch: vi.fn(async (input) => ({
      plan: buildLaunchPlan({
        ...input,
        sessions,
        now: Date.now(),
        platform: 'windows',
      }),
      executionIds: ['queued-1'],
      failures: [],
      cancelled: false,
    })),
    cancel: vi.fn(async () => undefined),
    readExecution: vi.fn(() => undefined),
    navigateToTerminals: vi.fn(),
  };
}

describe('OpenInTerminalDialog', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  it('previews preserved inventory and requires approval before launch', async () => {
    const runtime = runtimeFixture();
    render(<OpenInTerminalDialog open onOpenChange={vi.fn()} runtime={runtime} />);

    await screen.findByText(/2 already present/i);
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    fireEvent.change(screen.getByLabelText(/project directory/i), {
      target: { value: 'C:\\Work Tree' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(
      screen.getByText(/Preserve all 2 existing terminals and open 1 new OpenCode/i),
    ).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Startup command preview' }).textContent).toContain(
      "'C:\\Work Tree'",
    );
    expect(runtime.launch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Approve and launch/i }));
    await screen.findByText('Terminal launch queued');
    expect(runtime.launch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'View terminals' }));
    expect(runtime.navigateToTerminals).toHaveBeenCalledTimes(1);
  });

  it('shows guided setup and blocks preview for an unavailable provider', async () => {
    const runtime = runtimeFixture(false);
    render(<OpenInTerminalDialog open onOpenChange={vi.fn()} runtime={runtime} />);

    await waitFor(() =>
      expect(screen.getByText(/Install OpenCode, then connect a model provider/i)).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: 'Preview' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('link', { name: /Setup guide/i }).getAttribute('href')).toBe(
      'https://opencode.ai/docs',
    );
  });
});
