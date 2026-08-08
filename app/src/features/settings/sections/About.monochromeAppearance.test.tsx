import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { About } from './About';

describe('About MonoChrome appearance', () => {
  beforeEach(() => {
    useAuthStore.setState({ telemetryOptIn: false });
  });

  afterEach(cleanup);

  it('gates radius, background-image, and shadow under exact monochrome only', () => {
    render(<About />);

    const root = document.querySelector<HTMLElement>('.mc7f-settings-about');
    expect(root).not.toBeNull();
    const className = root?.className ?? '';

    expect(className).toContain('[html[data-theme=monochrome]_&_*]:rounded-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:bg-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:shadow-none');

    // Ordinary-theme layout and the exact-theme accent rail stay intact.
    expect(className).toContain('flex flex-col gap-6');
    expect(className).toContain('[html[data-theme=monochrome]_&]:border-l-foreground/20');
    expect(className).not.toMatch(/gradient|blur/);

    // Meaningful product surface and copy are preserved.
    expect(screen.getByRole('heading', { name: 'About' })).toBeTruthy();
    expect(screen.getByText('Build')).toBeTruthy();
    expect(screen.getByText('Resources')).toBeTruthy();
    const credits = screen.getByRole('link', { name: /Open Source Credits/i });
    expect(credits.getAttribute('href')).toBe(
      'https://github.com/Cookie774-GameDev/VibeSpace/blob/main/docs/oss/THIRD_PARTY_NOTICES.md',
    );
    expect(screen.getByText(/Privacy and anonymous telemetry/)).toBeTruthy();
  });
});
