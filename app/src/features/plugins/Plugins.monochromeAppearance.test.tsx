import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Plugins } from './Plugins';
import { usePluginStore } from './store';
import { useAuthStore } from '@/stores/auth';

describe('Plugins MonoChrome appearance', () => {
  beforeEach(() => {
    useAuthStore.setState({ cloudSession: null, localUserId: 'account-a' });
    usePluginStore.setState({
      connectionsByAccount: {},
      installedPluginIdsByAccount: { 'account-a': ['github'] },
      pinnedPluginIdsByAccount: {},
    });
  });

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

  it('gates the compact authorization dialog surface under exact monochrome', () => {
    render(<Plugins />);

    const githubCard = screen.getByTestId('plugin-card-github');
    fireEvent.click(within(githubCard).getByRole('button', { name: /Connect/ }));

    const dialog = document.querySelector<HTMLElement>('.sakura-plugin-dialog');
    expect(dialog).not.toBeNull();
    const dialogClassName = dialog?.className ?? '';

    expect(dialogClassName).toContain('[html[data-theme=monochrome]_&]:rounded-none');
    expect(dialogClassName).toContain('[html[data-theme=monochrome]_&]:shadow-none');
    expect(document.querySelector('.mc7f-plugins-credential-hero')).toBeNull();
  });
});
