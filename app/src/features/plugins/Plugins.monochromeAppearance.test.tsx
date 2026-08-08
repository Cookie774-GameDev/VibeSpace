import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Plugins } from './Plugins';

describe('Plugins MonoChrome appearance', () => {
  afterEach(cleanup);

  it('gates radius, background-image, and shadow under exact monochrome only', () => {
    render(<Plugins />);

    const root = document.querySelector<HTMLElement>('.mc7f-plugins');
    expect(root).not.toBeNull();
    const className = root?.className ?? '';

    expect(className).toContain('[html[data-theme=monochrome]_&_*]:rounded-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:bg-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:shadow-none');

    // Ordinary-theme layout and the exact-theme accent rail stay intact.
    expect(className).toContain('flex flex-col gap-5');
    expect(className).toContain('[html[data-theme=monochrome]_&]:border-l-foreground/20');
    expect(className).not.toMatch(/gradient|blur/);

    // Meaningful product surface and copy are preserved.
    expect(screen.getByRole('heading', { name: 'Plugins' })).toBeTruthy();
    expect(screen.getByText(/Tokens are never/)).toBeTruthy();
  }, 10_000);

  it('gates the credential hero gradient inside the setup dialog under exact monochrome', () => {
    render(<Plugins />);

    const githubCard = screen.getByTestId('plugin-card-github');
    fireEvent.click(within(githubCard).getByRole('button', { name: /Connect/ }));

    const hero = document.querySelector<HTMLElement>('.mc7f-plugins-credential-hero');
    expect(hero).not.toBeNull();
    const heroClassName = hero?.className ?? '';

    // Ordinary-theme gradient is preserved, but gated off under exact monochrome.
    expect(heroClassName).toMatch(/bg-gradient-to-br/);
    expect(heroClassName).toContain('[html[data-theme=monochrome]_&]:bg-none');
    expect(heroClassName).toContain('[html[data-theme=monochrome]_&]:rounded-none');
  });
});
