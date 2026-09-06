// @vitest-environment jsdom

import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NativeAppPickerDialog } from './NativeAppPickerDialog';
import type { NativeAppDescriptor } from './nativeApps';

const apps: NativeAppDescriptor[] = [
  { id: 'chatgpt', name: 'ChatGPT', running: true, pinned: true, launchable: true },
  { id: 'edge', name: 'Microsoft Edge', running: true, pinned: false, launchable: true },
  { id: 'broken', name: 'Unavailable app', running: false, pinned: false, launchable: false },
];

describe('NativeAppPickerDialog', () => {
  it('keeps unavailable apps discoverable with recovery guidance', () => {
    render(
      <NativeAppPickerDialog
        open
        apps={apps}
        onOpenChange={vi.fn()}
        onChoose={vi.fn()}
        onPickExecutable={vi.fn()}
      />,
    );
    expect(screen.getByText('Unavailable app')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Open Unavailable app' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByText(/start the app|choose its executable/i)).toBeTruthy();
  });
  it('searches detected apps, reports running state, and opens the selected app', () => {
    const onChoose = vi.fn();
    render(
      <NativeAppPickerDialog
        open
        apps={apps}
        onOpenChange={vi.fn()}
        onChoose={onChoose}
        onPickExecutable={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Open an app' })).toBeTruthy();
    expect(screen.getAllByText('Running')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search detected apps'), {
      target: { value: 'edge' },
    });
    expect(screen.queryByRole('button', { name: /Open ChatGPT/i })).toBeNull();
    screen.getByRole('button', { name: /Open Microsoft Edge/i }).click();
    expect(onChoose).toHaveBeenCalledWith(apps[1]);
    expect(screen.queryByText('Unavailable app')).toBeNull();
  });

  it('allows a validated executable to be picked when an app is not detected', async () => {
    const custom: NativeAppDescriptor = {
      id: 'custom',
      name: 'Demo',
      path: 'C:\Tools\Demo.exe',
      processName: 'Demo.exe',
      running: false,
      pinned: false,
      launchable: true,
    };
    const onChoose = vi.fn();
    const onPickExecutable = vi.fn(async () => custom);
    render(
      <NativeAppPickerDialog
        open
        apps={apps}
        onOpenChange={vi.fn()}
        onChoose={onChoose}
        onPickExecutable={onPickExecutable}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose executable' }));
    await waitFor(() => expect(onPickExecutable).toHaveBeenCalledOnce());
    expect(onChoose).toHaveBeenCalledWith(custom);
  });
});
