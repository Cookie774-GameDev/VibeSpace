import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAllAboutMeStore } from '@/features/all-about-me/store';
import { AllAboutMe } from './AllAboutMe';

describe('AllAboutMe MonoChrome appearance', () => {
  beforeEach(() => {
    useAllAboutMeStore.setState(useAllAboutMeStore.getInitialState(), true);
  });

  afterEach(cleanup);

  it('gates radius, background-image, and shadow under exact monochrome only', () => {
    render(<AllAboutMe completePrompt={vi.fn()} modelOptions={[]} />);

    const root = document.querySelector<HTMLElement>('.mc7f-settings-all-about-me');
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
    expect(screen.getByRole('heading', { name: 'All About Me' })).toBeTruthy();
    expect(screen.getByText(/60-question test/)).toBeTruthy();
    expect(screen.getByText(/Private profile Jarvis uses/i)).toBeTruthy();
  });
});
