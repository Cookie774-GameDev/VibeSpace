import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeWindowsShellGuidance } from './OpenCodeWindowsShellGuidance';

afterEach(cleanup);

describe('OpenCode Windows shell guidance', () => {
  it('offers conditional guidance on a clean Windows account without detecting or opening anything', () => {
    const openInstructions = vi.fn(async () => {});
    render(<OpenCodeWindowsShellGuidance native platform="Win32" openInstructions={openInstructions} />);
    expect(screen.getByRole('region', { name: 'Windows shell tool recovery' })).toBeTruthy();
    expect(screen.getByText(/If an OpenCode shell tool reports that Bash is unavailable/)).toBeTruthy();
    expect(screen.getByText(/fully close and reopen VibeSpace/)).toBeTruthy();
    expect(screen.getByText(/does not replace provider sign-in/)).toBeTruthy();
    expect(screen.getByText(/custom shell/)).toBeTruthy();
    expect(openInstructions).not.toHaveBeenCalled();
  });

  it('does not offer Windows-specific recovery in a non-native environment', () => {
    const openInstructions = vi.fn(async () => {});
    const view = render(<OpenCodeWindowsShellGuidance native={false} platform="Win32" openInstructions={openInstructions} />);
    expect(view.container.childElementCount).toBe(0);
    expect(openInstructions).not.toHaveBeenCalled();
  });

  it('does not offer Windows-specific recovery for macOS or Linux', () => {
    const openInstructions = vi.fn(async () => {});
    const view = render(<OpenCodeWindowsShellGuidance native platform="MacIntel" openInstructions={openInstructions} />);
    expect(view.container.childElementCount).toBe(0);
    view.rerender(<OpenCodeWindowsShellGuidance native platform="Linux x86_64" openInstructions={openInstructions} />);
    expect(view.container.childElementCount).toBe(0);
    expect(openInstructions).not.toHaveBeenCalled();
  });

  it('opens only the fixed official instructions after an explicit click', async () => {
    const openInstructions = vi.fn(async () => {});
    render(<OpenCodeWindowsShellGuidance native platform="Win32" openInstructions={openInstructions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Git for Windows instructions' }));
    await waitFor(() => expect(openInstructions).toHaveBeenCalledTimes(1));
    expect(openInstructions).toHaveBeenCalledWith('https://git-scm.com/install/windows');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not mistake Darwin or an unknown platform for Windows', () => {
    const view = render(<OpenCodeWindowsShellGuidance native platform="Darwin" />);
    expect(view.container.childElementCount).toBe(0);
    view.rerender(<OpenCodeWindowsShellGuidance native platform="" />);
    expect(view.container.childElementCount).toBe(0);
  });

  it('reports instruction-opening failure and permits explicit recovery', async () => {
    const openInstructions = vi.fn()
      .mockRejectedValueOnce(new Error('blocked opener'))
      .mockResolvedValueOnce(undefined);
    render(<OpenCodeWindowsShellGuidance native platform="Win32" openInstructions={openInstructions} />);
    const button = screen.getByRole('button', { name: 'Open Git for Windows instructions' });
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain('https://git-scm.com/install/windows');
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(openInstructions).toHaveBeenCalledTimes(2);
  });
});
