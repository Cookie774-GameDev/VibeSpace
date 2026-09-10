import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelFileExplorer, openFileExplorer } from './fileExplorerStore';

const testMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  resolveExplorerPlaces: vi.fn(),
  statProjectPath: vi.fn(),
}));

vi.mock('@/lib/fs', async () => {
  const actual = await vi.importActual<typeof import('@/lib/fs')>('@/lib/fs');
  return {
    ...actual,
    listDirectory: testMocks.listDirectory,
    readTextFileSample: async (path: string) => ({ ok: true, path, content: 'fixture' }),
    statProjectPath: testMocks.statProjectPath,
  };
});

vi.mock('./fileExplorerPlaces', async () => {
  const actual =
    await vi.importActual<typeof import('./fileExplorerPlaces')>('./fileExplorerPlaces');
  return {
    ...actual,
    resolveExplorerPlaces: testMocks.resolveExplorerPlaces,
  };
});

import { FileExplorerHost } from './FileExplorerDialog';

beforeEach(() => {
  cancelFileExplorer();
  testMocks.listDirectory.mockReset();
  testMocks.resolveExplorerPlaces.mockReset();
  testMocks.statProjectPath.mockReset();
  testMocks.statProjectPath.mockImplementation(async (path: string) => ({
    ok: true,
    path,
    kind: 'file',
  }));
  testMocks.resolveExplorerPlaces.mockResolvedValue([
    { id: 'home', label: 'Home', path: 'C:\\Users\\viper', icon: 'home' },
  ]);
});

afterEach(() => {
  cleanup();
  cancelFileExplorer();
  vi.useRealTimers();
});

describe('FileExplorerDialog loading resilience', () => {
  it('validates Windows canonical drive paths while returning the exact listed identity', async () => {
    const path = String.raw`\\?\C:\first\safe.bin`;
    testMocks.listDirectory.mockResolvedValue({
      ok: true,
      path: 'C:\\first',
      entries: [{ name: 'safe.bin', path, isDir: false }],
    });
    const result = openFileExplorer({ mode: 'file', initialPath: 'C:\\first' });
    render(<FileExplorerHost />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'safe.bin' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select file' }));
    });
    expect(testMocks.statProjectPath).toHaveBeenCalledWith('C:\\first\\safe.bin', false, {
      root: 'C:\\first',
    });
    expect(await result).toEqual({ ok: true, paths: [path] });
  });

  it('preserves a typed destination before Go while startup Places completes', async () => {
    let finish!: (value: unknown) => void;
    testMocks.resolveExplorerPlaces.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    testMocks.listDirectory.mockImplementation(async (path: string) => ({
      ok: true,
      path,
      entries: [],
    }));
    void openFileExplorer({ mode: 'folder' });
    render(<FileExplorerHost />);
    fireEvent.change(screen.getByLabelText('Current path'), { target: { value: 'C:\\typed' } });
    await act(async () => {
      finish([{ id: 'home', label: 'Home', path: 'C:\\home', icon: 'home' }]);
    });
    expect((screen.getByLabelText('Current path') as HTMLInputElement).value).toBe('C:\\typed');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    });
    expect(testMocks.listDirectory).toHaveBeenCalledWith('C:\\typed', {});
  });

  it('preserves a typed destination when the initial directory finishes loading', async () => {
    let finish!: (value: unknown) => void;
    testMocks.listDirectory.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    void openFileExplorer({ mode: 'folder', initialPath: 'C:\\home' });
    render(<FileExplorerHost />);
    fireEvent.change(screen.getByLabelText('Current path'), { target: { value: 'C:\\typed' } });
    await act(async () => {
      finish({ ok: true, path: 'C:\\home', entries: [] });
    });
    expect((screen.getByLabelText('Current path') as HTMLInputElement).value).toBe('C:\\typed');
  });

  it('does not replace user navigation when startup Places resolves later', async () => {
    let finishPlaces!: (value: unknown) => void;
    testMocks.resolveExplorerPlaces.mockReturnValue(
      new Promise((resolve) => {
        finishPlaces = resolve;
      }),
    );
    testMocks.listDirectory.mockImplementation(async (path: string) => ({
      ok: true,
      path,
      entries: [],
    }));
    void openFileExplorer({ mode: 'folder' });
    render(<FileExplorerHost />);
    fireEvent.change(screen.getByLabelText('Current path'), { target: { value: 'C:\\chosen' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    });
    await act(async () => {
      finishPlaces([{ id: 'home', label: 'Home', path: 'C:\\home', icon: 'home' }]);
    });
    expect((screen.getByLabelText('Current path') as HTMLInputElement).value).toBe('C:\\chosen');
    expect(testMocks.listDirectory).not.toHaveBeenCalledWith('C:\\home', expect.anything());
  });

  it('rejects a selected file removed before confirmation and permits recovery', async () => {
    testMocks.listDirectory.mockResolvedValue({
      ok: true,
      path: 'C:\\first',
      entries: [
        { name: 'gone.bin', path: 'C:\\first\\gone.bin', isDir: false },
        { name: 'safe.bin', path: 'C:\\first\\safe.bin', isDir: false },
      ],
    });
    testMocks.statProjectPath.mockResolvedValueOnce({
      ok: false,
      path: 'C:\\first\\gone.bin',
      error: { code: 'not_found' },
    });
    const result = openFileExplorer({ mode: 'files', initialPath: 'C:\\first' });
    const resolved = vi.fn();
    void result.then(resolved);
    render(<FileExplorerHost />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('gone.bin'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select (1)' }));
    });
    expect(resolved).not.toHaveBeenCalled();
    expect(testMocks.statProjectPath).toHaveBeenCalledWith('C:\\first\\gone.bin', false, {
      root: 'C:\\first',
    });
    expect(screen.getByRole('alert').textContent).toMatch(/not found/i);
    fireEvent.click(screen.getByText('safe.bin'));
    expect(screen.getByRole('button', { name: 'safe.bin' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select (1)' }));
    });
    expect(await result).toEqual({ ok: true, paths: ['C:\\first\\safe.bin'] });
  });

  it('clears the previous selection while navigating and after a failed listing', async () => {
    testMocks.listDirectory.mockResolvedValueOnce({
      ok: true,
      path: 'C:\\first',
      entries: [{ name: 'alpha.txt', path: 'C:\\first\\alpha.txt', isDir: false, size: 5 }],
    });
    let finish!: (value: unknown) => void;
    testMocks.listDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    void openFileExplorer({ mode: 'files', initialPath: 'C:\\first' });
    render(<FileExplorerHost />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('alpha.txt'));
    expect((screen.getByRole('button', { name: 'Select (1)' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.change(screen.getByLabelText('Current path'), { target: { value: 'C:\\denied' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.queryByText('alpha.txt')).toBeNull();
    expect((screen.getByRole('button', { name: 'Select' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => {
      finish({ ok: false, path: 'C:\\denied', error: { code: 'not_found' } });
    });
    expect((screen.getByRole('button', { name: 'Select' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('does not publish an outstanding listing after cancel into a replacement session', async () => {
    let finish!: (value: unknown) => void;
    testMocks.listDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = openFileExplorer({ mode: 'file', initialPath: 'C:\\old' });
    render(<FileExplorerHost />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await result).toEqual({ ok: false, cancelled: true });
    testMocks.listDirectory.mockResolvedValueOnce({ ok: true, path: 'C:\\new', entries: [] });
    await act(async () => {
      void openFileExplorer({ mode: 'file', initialPath: 'C:\\new' });
    });
    await act(async () => {
      finish({
        ok: true,
        path: 'C:\\old',
        entries: [{ name: 'late.txt', path: 'C:\\old\\late.txt', isDir: false }],
      });
    });
    expect(screen.queryByText('late.txt')).toBeNull();
    expect((screen.getByLabelText('Current path') as HTMLInputElement).value).toBe('C:\\new');
  });

  it('starts an explicit initial folder without waiting for Places resolution', async () => {
    testMocks.resolveExplorerPlaces.mockReturnValue(new Promise(() => undefined));
    testMocks.listDirectory.mockResolvedValue({
      ok: true,
      path: 'C:\\project',
      entries: [{ name: 'alpha.txt', path: 'C:\\project\\alpha.txt', isDir: false, size: 5 }],
    });

    void openFileExplorer({ mode: 'file', initialPath: 'C:\\project' });
    render(<FileExplorerHost />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testMocks.listDirectory).toHaveBeenCalledWith('C:\\project', {});
    expect(screen.queryByText('alpha.txt')).not.toBeNull();
  });

  it('keeps the newest folder when an older listing resolves last', async () => {
    const slowResult = {
      ok: true as const,
      path: 'C:\\slow',
      entries: [{ name: 'stale.txt', path: 'C:\\slow\\stale.txt', isDir: false, size: 5 }],
    };
    let resolveSlow!: (value: typeof slowResult) => void;
    const slowRequest = new Promise<typeof slowResult>((resolve) => {
      resolveSlow = resolve;
    });
    testMocks.listDirectory.mockReturnValueOnce(slowRequest).mockResolvedValueOnce({
      ok: true,
      path: 'C:\\fast',
      entries: [{ name: 'current.txt', path: 'C:\\fast\\current.txt', isDir: false, size: 7 }],
    });

    void openFileExplorer({ mode: 'file', initialPath: 'C:\\slow' });
    render(<FileExplorerHost />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('Current path'), {
      target: { value: 'C:\\fast' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('current.txt')).not.toBeNull();

    await act(async () => {
      resolveSlow(slowResult);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText('stale.txt')).toBeNull();
    expect(screen.queryByText('current.txt')).not.toBeNull();
    expect((screen.getByLabelText('Current path') as HTMLInputElement).value).toBe('C:\\fast');
  });

  it('adds Places that resolve after the fast-start deadline', async () => {
    vi.useFakeTimers();
    let resolvePlaces!: (
      value: Array<{
        id: string;
        label: string;
        path: string;
        icon: 'desktop';
      }>,
    ) => void;
    testMocks.resolveExplorerPlaces.mockReturnValue(
      new Promise((resolve) => {
        resolvePlaces = resolve;
      }),
    );
    testMocks.listDirectory.mockResolvedValue({
      ok: true,
      path: 'C:\\project',
      entries: [],
    });

    void openFileExplorer({ mode: 'file', initialPath: 'C:\\project' });
    render(<FileExplorerHost />);

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'Desktop' })).toBeNull();

    await act(async () => {
      resolvePlaces([
        { id: 'desktop', label: 'Desktop', path: 'C:\\Users\\viper\\Desktop', icon: 'desktop' },
      ]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole('button', { name: 'Desktop' })).not.toBeNull();
  });

  it('stops the spinner when a directory listing never settles', async () => {
    vi.useFakeTimers();
    testMocks.listDirectory.mockReturnValue(new Promise(() => undefined));

    void openFileExplorer({ mode: 'file', initialPath: 'C:\\project' });
    render(<FileExplorerHost />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(testMocks.listDirectory).toHaveBeenCalled();
    expect(screen.queryByText('Loading…')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.queryByText(/taking too long/i)).not.toBeNull();
  });
});
