import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginLogo } from './PluginLogo';

const PLUGIN = {
  id: 'github',
  name: 'GitHub',
  credentialUrl: 'https://github.com/settings/tokens',
  docsUrl: 'https://docs.github.com/',
};

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('PluginLogo runtime isolation', () => {
  it('does not assign a remote image source in the exact visual-test profile', () => {
    vi.stubEnv('VITE_VIBESPACE_RUNTIME_PROFILE', 'monochrome-visual-test');

    const mounted = render(<PluginLogo plugin={PLUGIN} />);

    expect(mounted.container.querySelector('img')).toBeNull();
    expect(mounted.getByText('GH')).toBeTruthy();
  });

  it('preserves remote logo loading in ordinary runtime', () => {
    vi.stubEnv('VITE_VIBESPACE_RUNTIME_PROFILE', undefined);

    const mounted = render(<PluginLogo plugin={PLUGIN} />);
    const fallback = mounted.getByTestId('plugin-logo-fallback');
    const image = mounted.container.querySelector('img');

    expect(fallback.textContent).toBe('GH');
    expect(image?.getAttribute('src')).toBe('https://cdn.simpleicons.org/github');
    expect(image?.getAttribute('loading')).toBe('lazy');
    expect(image?.getAttribute('decoding')).toBe('async');
    expect(image?.getAttribute('data-loaded')).toBe('false');

    fireEvent.load(image!);
    expect(image?.getAttribute('data-loaded')).toBe('true');
  });
});
