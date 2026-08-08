import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  applyAppBrightnessToDocument,
  applyThemeToDocument,
  mergePersistedUiState,
  resolveTheme,
  useUIStore,
} from './ui';
import type { SelectableTheme } from '@/features/appearance/themeContract';

describe('UI theme resolution', () => {
  afterEach(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.removeAttribute('data-theme-preference');
    useUIStore.setState({ theme: 'default' });
  });

  it('keeps Jarvis Core as an independent selectable theme', () => {
    expect(resolveTheme('jarvis')).toBe('jarvis');
    applyThemeToDocument('jarvis');
    expect(document.documentElement.getAttribute('data-theme')).toBe('jarvis');
    expect(document.documentElement.getAttribute('data-theme-preference')).toBe('jarvis');
  });

  it('resolves the public Default theme to the established dark skin', () => {
    expect(resolveTheme('default')).toBe('dark');
    applyThemeToDocument('default');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme-preference')).toBe('default');
  });

  it('keeps VibeSpace as an independent selectable theme', () => {
    expect(resolveTheme('vibespace')).toBe('vibespace');
    applyThemeToDocument('vibespace');
    expect(document.documentElement.getAttribute('data-theme')).toBe('vibespace');
    expect(document.documentElement.getAttribute('data-theme-preference')).toBe('vibespace');
  });

  it('resolves MonoChrome to its own document theme and preference', () => {
    expect(resolveTheme('monochrome')).toBe('monochrome');
    applyThemeToDocument('monochrome');
    expect(document.documentElement.getAttribute('data-theme')).toBe('monochrome');
    expect(document.documentElement.getAttribute('data-theme-preference')).toBe('monochrome');
  });

  it('applies theme changes synchronously through the UI store', () => {
    type StoreState = ReturnType<typeof useUIStore.getState>;
    type SetThemeArgument = Parameters<StoreState['setTheme']>[0];
    expectTypeOf<SetThemeArgument>().toEqualTypeOf<SelectableTheme>();

    useUIStore.getState().setTheme('monochrome');
    expect(useUIStore.getState().theme).toBe('monochrome');
    expect(document.documentElement.getAttribute('data-theme')).toBe('monochrome');
  });
});

describe('product tutorial persistence via finishOnboarding', () => {
  afterEach(() => {
    useUIStore.setState({
      onboardingComplete: false,
      productTutorialStatus: null,
    });
  });

  it('marks product tutorial pending when setup onboarding finishes', () => {
    useUIStore.setState({ onboardingComplete: false, productTutorialStatus: null });
    useUIStore.getState().finishOnboarding();
    expect(useUIStore.getState().onboardingComplete).toBe(true);
    expect(useUIStore.getState().productTutorialStatus).toBe('pending');
  });

  it('does not re-force tutorial if already skipped or completed', () => {
    useUIStore.setState({ productTutorialStatus: 'skipped' });
    useUIStore.getState().finishOnboarding();
    expect(useUIStore.getState().productTutorialStatus).toBe('skipped');

    useUIStore.setState({ productTutorialStatus: 'completed' });
    useUIStore.getState().finishOnboarding();
    expect(useUIStore.getState().productTutorialStatus).toBe('completed');
  });
});

describe('application brightness', () => {
  afterEach(() => {
    useUIStore.setState({ appBrightness: 100 });
    document.documentElement.style.removeProperty('--vibespace-app-brightness');
    document.documentElement.style.removeProperty('--vibespace-app-dim-opacity');
    document.documentElement.style.removeProperty('--vibespace-app-boost-opacity');
    document.documentElement.removeAttribute('data-app-brightness-mode');
  });

  it('clamps brightness and maps it to bounded static overlay opacity', () => {
    useUIStore.getState().setAppBrightness(250);
    expect(useUIStore.getState().appBrightness).toBe(200);
    expect(document.documentElement.style.getPropertyValue('--vibespace-app-brightness')).toBe('2');
    expect(document.documentElement.style.getPropertyValue('--vibespace-app-dim-opacity')).toBe(
      '0',
    );
    expect(document.documentElement.style.getPropertyValue('--vibespace-app-boost-opacity')).toBe(
      '0.35',
    );
    expect(document.documentElement.getAttribute('data-app-brightness-mode')).toBe('boost');

    useUIStore.getState().setAppBrightness(-20);
    expect(useUIStore.getState().appBrightness).toBe(0);
    expect(document.documentElement.style.getPropertyValue('--vibespace-app-brightness')).toBe('0');
    expect(document.documentElement.style.getPropertyValue('--vibespace-app-dim-opacity')).toBe(
      '1',
    );
    expect(document.documentElement.style.getPropertyValue('--vibespace-app-boost-opacity')).toBe(
      '0',
    );
    expect(document.documentElement.getAttribute('data-app-brightness-mode')).toBe('dim');
  });

  it('normalizes malformed hydrated brightness without replacing store actions', () => {
    const current = useUIStore.getState();
    const merged = mergePersistedUiState({ appBrightness: Number.NaN }, current);
    expect(merged.appBrightness).toBe(100);
    expect(merged.setAppBrightness).toBe(current.setAppBrightness);

    applyAppBrightnessToDocument(125);
    expect(document.documentElement.style.getPropertyValue('--vibespace-app-brightness')).toBe(
      '1.25',
    );
    expect(document.documentElement.style.getPropertyValue('--vibespace-app-dim-opacity')).toBe(
      '0',
    );
    expect(document.documentElement.style.getPropertyValue('--vibespace-app-boost-opacity')).toBe(
      '0.0875',
    );
    expect(document.documentElement.getAttribute('data-app-brightness-mode')).toBe('boost');

    applyAppBrightnessToDocument(100);
    expect(document.documentElement.getAttribute('data-app-brightness-mode')).toBe('normal');
  });

  it('does not apply a compositor filter to the entire app root', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');
    const rootRule = css.match(/#root\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? '';

    expect(rootRule).not.toMatch(/\bfilter\s*:/u);
    expect(css).toContain("html[data-app-brightness-mode='dim'] #root::before");
    expect(css).toContain("html[data-app-brightness-mode='boost'] #root::after");
    expect(css).toContain('opacity: var(--vibespace-app-dim-opacity, 0)');
    expect(css).toContain('opacity: var(--vibespace-app-boost-opacity, 0)');
  });
});
