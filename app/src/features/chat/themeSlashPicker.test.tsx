import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyThemeToDocument } from '@/stores/ui';
import {
  ConsoleThemeSlashPicker,
  ThemeSlashPicker,
  type ThemeSlashPickerRef,
} from './themeSlashPicker';

describe('ThemeSlashPicker', () => {
  afterEach(() => {
    applyThemeToDocument('default');
    localStorage.clear();
  });

  it('renders the four release appearances with Codex-style diff previews', () => {
    render(
      <ThemeSlashPicker
        commandLabel="themes"
        initialTheme="default"
        onCommit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getAllByTestId('theme-code-preview')).toHaveLength(4);
    expect(screen.getAllByLabelText(/code colors$/i)).toHaveLength(4);
    expect(screen.getByTestId('theme-diff-preview')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('14')).toBeTruthy();
    expect(screen.getByText(/fn greet/)).toBeTruthy();
    expect(screen.queryByText('VibeSpace')).toBeNull();
    expect(screen.queryByText('Sakura')).toBeNull();
    expect(screen.queryByText('Origami')).toBeNull();
  });

  it('previews arrow navigation immediately without persisting, then commits on Enter', () => {
    localStorage.setItem('jarvis-ui', 'committed-sentinel');
    const ref = createRef<ThemeSlashPickerRef>();
    const onCommit = vi.fn();

    render(
      <ThemeSlashPicker
        ref={ref}
        commandLabel="appearance"
        initialTheme="default"
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );

    act(() => ref.current?.moveDown());

    expect(document.documentElement.dataset.themePreference).toBe('monochrome');
    expect(localStorage.getItem('jarvis-ui')).toBe('committed-sentinel');
    expect(onCommit).not.toHaveBeenCalled();

    act(() => ref.current?.selectCurrent());

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith('monochrome');
  });

  it('restores the committed appearance when cancelled after rapid navigation', () => {
    const ref = createRef<ThemeSlashPickerRef>();
    const onCancel = vi.fn();

    render(
      <ThemeSlashPicker
        ref={ref}
        commandLabel="themes"
        initialTheme="jarvis"
        onCommit={vi.fn()}
        onCancel={onCancel}
      />,
    );

    act(() => {
      ref.current?.moveDown();
      ref.current?.moveDown();
      ref.current?.moveUp();
      ref.current?.cancel();
    });

    expect(document.documentElement.dataset.themePreference).toBe('jarvis');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('restores the committed appearance if the picker unmounts without a selection', () => {
    const ref = createRef<ThemeSlashPickerRef>();
    const rendered = render(
      <ThemeSlashPicker
        ref={ref}
        commandLabel="appearance"
        initialTheme="warm"
        onCommit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    act(() => ref.current?.moveUp());
    expect(document.documentElement.dataset.themePreference).toBe('monochrome');

    rendered.unmount();

    expect(document.documentElement.dataset.themePreference).toBe('warm');
  });
});

describe('ConsoleThemeSlashPicker', () => {
  it('shows existing chat syntax themes with the selected code-output colors', () => {
    render(
      <ConsoleThemeSlashPicker
        initialProfile="graphite"
        onCommit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Paper White')).toBeTruthy();
    expect(screen.getByText('OLED Void')).toBeTruthy();
    expect(screen.getAllByTestId('theme-code-preview')).toHaveLength(10);
    expect(screen.getByTestId('theme-diff-preview').getAttribute('data-code-theme')).toBe(
      'graphite',
    );
  });

  it('previews syntax colors while navigating and commits only on selection', () => {
    const ref = createRef<ThemeSlashPickerRef>();
    const onCommit = vi.fn();

    render(
      <ConsoleThemeSlashPicker
        ref={ref}
        initialProfile="graphite"
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );

    act(() => ref.current?.moveDown());

    expect(screen.getByTestId('theme-diff-preview').getAttribute('data-code-theme')).toBe(
      'midnight-blue',
    );
    expect(onCommit).not.toHaveBeenCalled();

    act(() => ref.current?.selectCurrent());
    expect(onCommit).toHaveBeenCalledWith('midnight-blue');
  });
});
