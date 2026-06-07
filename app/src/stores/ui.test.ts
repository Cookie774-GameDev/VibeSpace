import { afterEach } from 'vitest';
import { applyThemeToDocument, resolveTheme, useUIStore } from './ui';

describe('UI theme resolution', () => {
  afterEach(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.removeAttribute('data-theme-preference');
    useUIStore.setState({ theme: 'dark' });
  });

  it('resolves system preference to the actual light or dark theme', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('keeps Jarvis Core as an independent selectable theme', () => {
    expect(resolveTheme('jarvis')).toBe('jarvis');
    applyThemeToDocument('jarvis');
    expect(document.documentElement.getAttribute('data-theme')).toBe('jarvis');
    expect(document.documentElement.getAttribute('data-theme-preference')).toBe('jarvis');
  });

  it('applies theme changes synchronously through the UI store', () => {
    useUIStore.getState().setTheme('jarvis');
    expect(useUIStore.getState().theme).toBe('jarvis');
    expect(document.documentElement.getAttribute('data-theme')).toBe('jarvis');
  });
});
