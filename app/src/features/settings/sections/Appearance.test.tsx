import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useFullscreenStore } from '@/features/fullscreen';
import { useUIStore } from '@/stores/ui';
import { Appearance } from './Appearance';

describe('Appearance theme selector', () => {
  afterEach(() => {
    cleanup();
    useUIStore.setState({
      theme: 'default',
      appBrightness: 100,
      sakuraPetalsEnabled: true,
      sakuraPetalSpeed: 'normal',
    });
    useFullscreenStore.setState({
      focusActive: false,
      systemActive: false,
      activationOrder: [],
      preferences: {
        rememberFocusMode: false,
        rememberSystemFullscreen: false,
        restoreFullscreenOnRestart: false,
        systemFullscreenBehavior: 'always-hidden',
      },
      nativeAvailability: 'web-preview',
      nativePending: false,
      error: null,
    });
  });

  it('renders exactly four release themes and applies Jarvis One', () => {
    useUIStore.setState({ theme: 'default' });
    render(<Appearance />);

    const themes = screen.getByRole('radiogroup', { name: 'App theme' });
    expect(within(themes).getAllByRole('radio')).toHaveLength(4);
    expect(
      within(themes)
        .getByRole('radio', { name: /Default/ })
        .getAttribute('aria-checked'),
    ).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: /Jarvis One/ }));
    expect(useUIStore.getState().theme).toBe('jarvis');
    expect(document.documentElement.dataset.theme).toBe('jarvis');
  });

  it('keeps VibeSpace, Sakura, and Origami out of the current release selector', () => {
    render(<Appearance />);

    expect(screen.queryByRole('radio', { name: /^VibeSpace/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: /^Sakura/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: /^Origami/ })).toBeNull();
    expect(screen.getByRole('radio', { name: /^Warm/ })).toBeTruthy();
  });

  it('offers Warm as an espresso-and-ivory choice and applies it immediately', () => {
    render(<Appearance />);

    const warm = screen.getByRole('radio', { name: /^Warm/ });
    expect(warm.textContent).toContain('Espresso and ivory paper workspace.');
    expect(warm.querySelector('svg')?.getAttribute('class')).toMatch(/\blucide\b/);

    fireEvent.click(warm);
    expect(useUIStore.getState().theme).toBe('warm');
    expect(document.documentElement.dataset.theme).toBe('warm');
    expect(document.documentElement.dataset.themePreference).toBe('warm');
  });

  it('shows persisted Sakura-only petal controls with accessible state', () => {
    useUIStore.setState({ theme: 'sakura' });
    render(<Appearance />);

    fireEvent.click(screen.getByRole('switch', { name: 'Falling petals' }));
    expect(useUIStore.getState().sakuraPetalsEnabled).toBe(false);

    fireEvent.click(screen.getByRole('radio', { name: 'Fast' }));
    expect(useUIStore.getState().sakuraPetalSpeed).toBe('fast');
    expect(screen.getByRole('radiogroup', { name: 'Petal speed' })).toBeTruthy();
  });

  it('does not add Sakura effect controls to another theme', () => {
    useUIStore.setState({ theme: 'monochrome' });
    render(<Appearance />);

    expect(screen.queryByRole('switch', { name: 'Falling petals' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Petal speed' })).toBeNull();
  });

  it('offers MonoChrome as the terminal-inspired fourth choice without surfacing Light', () => {
    render(<Appearance />);

    const monochrome = screen.getByRole('radio', { name: /MonoChrome/ });
    expect(monochrome.textContent).toContain('Terminal-inspired developer console.');
    expect(screen.queryByRole('radio', { name: /Light/ })).toBeNull();

    fireEvent.click(monochrome);
    expect(useUIStore.getState().theme).toBe('monochrome');
    expect(document.documentElement.dataset.theme).toBe('monochrome');
  });

  it('changes and resets VibeSpace app brightness from 0 through 200 percent', () => {
    render(<Appearance />);
    const slider = screen.getByRole('slider', { name: 'App brightness' });

    fireEvent.change(slider, { target: { value: '175' } });
    expect(useUIStore.getState().appBrightness).toBe(175);
    expect(screen.getByText('175%')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reset app brightness' }));
    expect(useUIStore.getState().appBrightness).toBe(100);
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('exposes independent system fullscreen behavior and safe restoration preferences', () => {
    render(<Appearance />);

    const systemToggle = screen.getByRole('switch', { name: 'True System Fullscreen' });
    expect(systemToggle.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/installed VibeSpace desktop app/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Reveal on Edge Hover' }));
    expect(useFullscreenStore.getState().preferences.systemFullscreenBehavior).toBe(
      'reveal-on-edge-hover',
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Remember Workspace Focus Mode' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Remember True System Fullscreen' }));
    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Restore fullscreen state when VibeSpace restarts',
      }),
    );

    expect(useFullscreenStore.getState().preferences).toMatchObject({
      rememberFocusMode: true,
      rememberSystemFullscreen: true,
      restoreFullscreenOnRestart: true,
    });
  });
});
