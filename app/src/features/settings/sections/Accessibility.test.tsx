import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { Accessibility } from './Accessibility';

type MotionListener = (event: MediaQueryListEvent) => void;

function installMotionPreference(initial: boolean) {
  let listener: MotionListener | null = null;
  const addEventListener = vi.fn((_type: string, next: EventListenerOrEventListenerObject) => {
    if (typeof next === 'function') listener = next as MotionListener;
  });
  const removeEventListener = vi.fn((_type: string, next: EventListenerOrEventListenerObject) => {
    if (listener === next) listener = null;
  });
  const media = {
    matches: initial,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener,
    removeEventListener,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  );
  return {
    media,
    update(matches: boolean) {
      listener?.({ matches } as MediaQueryListEvent);
    },
  };
}

describe('Accessibility settings', () => {
  beforeEach(() => {
    useUIStore.setState({ composerStt: true });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useUIStore.setState({ composerStt: true });
  });

  it('groups every existing accessibility feature into named, scannable regions', () => {
    installMotionPreference(false);
    render(<Accessibility />);

    const speech = screen.getByRole('region', { name: 'Speech and dictation' });
    expect(
      within(speech).getByRole('switch', { name: 'Voice-to-text in the composer' }),
    ).toBeTruthy();
    expect(within(speech).getByText('VibeSpace global dictation')).toBeTruthy();

    const comfort = screen.getByRole('region', { name: 'Visual comfort and focus' });
    expect(within(comfort).getByText('Reduced motion')).toBeTruthy();
    expect(within(comfort).getByText('Workspace Focus Mode')).toBeTruthy();

    const assistive = screen.getByRole('region', { name: 'Assistive technology' });
    expect(within(assistive).getByText('Voice and screen readers')).toBeTruthy();
  });

  it('keeps the composer voice control keyboard-operable and persistently store-backed', () => {
    installMotionPreference(false);
    render(<Accessibility />);

    const control = screen.getByRole('switch', { name: 'Voice-to-text in the composer' });
    const descriptionId = control.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)).not.toBeNull();

    fireEvent.keyDown(control, { key: ' ' });
    fireEvent.click(control);
    expect(useUIStore.getState().composerStt).toBe(false);
  });

  it('announces operating-system reduced-motion changes without requiring a reload', () => {
    const preference = installMotionPreference(false);
    render(<Accessibility />);

    const status = screen.getByRole('status', { name: 'Reduced motion status' });
    expect(status.textContent).toContain('Off');

    act(() => preference.update(true));

    expect(status.textContent).toContain('Active');
    expect(preference.media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('marks decorative icons as hidden from assistive technology', () => {
    installMotionPreference(false);
    const { container } = render(<Accessibility />);

    const icons = Array.from(container.querySelectorAll('svg'));
    expect(icons.length).toBeGreaterThan(4);
    expect(icons.every((icon) => icon.getAttribute('aria-hidden') === 'true')).toBe(true);
  });
});
