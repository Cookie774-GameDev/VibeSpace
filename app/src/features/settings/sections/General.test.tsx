import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { General } from './General';
import {
  resetTaskbarUsageStoreForTests,
  taskbarUsageStore,
} from '@/features/taskbar-usage/taskbarUsageStore';

describe('General taskbar usage settings', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetTaskbarUsageStoreForTests();
  });

  it('offers the bounded controls and persists the master toggle automatically', () => {
    render(<General />);

    const master = screen.getByRole('switch', { name: 'Show taskbar usage module' });
    expect(master.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(master);
    expect(taskbarUsageStore.getSnapshot().preferences.enabled).toBe(false);
    expect(window.localStorage.getItem('vibespace.taskbar-usage.v1')).toContain('"enabled":false');
    expect(screen.getByRole('button', { name: 'Reset taskbar usage position' })).toBeTruthy();
    expect(screen.getByText('The first four visible providers are shown.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recycle Bin' })).toBeTruthy();
    expect(screen.getByText(/recoverable on this device for exactly 90 days/i)).toBeTruthy();
  });

  it('shows a recoverable sanitized mount diagnostic', () => {
    taskbarUsageStore.setRuntimeDiagnostic({
      code: 'WINDOW_CREATE_FAILED',
      message: 'The desktop usage window could not be created.',
      occurredAt: Date.now(),
      retryable: true,
    });
    render(<General />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('The desktop usage window could not be created.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry usage module' })).toBeTruthy();
  });
});
