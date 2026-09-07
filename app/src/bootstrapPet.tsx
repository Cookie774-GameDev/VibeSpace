import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/fraunces/500.css';
import '@fontsource/fraunces/600.css';
import '@fontsource/fraunces/700.css';
import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { resolveRuntimePlan } from './lib/runtimeProfile';
import './styles/globals.css';
import './styles/vibespace-theme.css';
import './styles/origami-chat.css';
import './styles/monochrome-theme.css';
import './styles/sakura-theme.css';
import './styles/warm-theme.css';
import './styles/origami-theme.css';

export type PetSurfaceView = 'pet-overlay' | 'pet-mini-panel';

type PetWindowComponent = React.ComponentType<{ runtimeEffectsEnabled?: boolean }>;

export interface PetSurfaceLoaders {
  overlay: () => Promise<{ PetOverlayWindow: PetWindowComponent }>;
  panel: () => Promise<{ PetMiniPanelWindow: PetWindowComponent }>;
}

const defaultPetSurfaceLoaders: PetSurfaceLoaders = {
  overlay: () => import('./features/pets/PetOverlayWindow'),
  panel: () => import('./features/pets/PetMiniPanelWindow'),
};

export function mountPetSurface(
  rootEl: HTMLElement,
  view: PetSurfaceView,
  loaders: PetSurfaceLoaders = defaultPetSurfaceLoaders,
): void {
  // Both companions paint their own silhouette, including rounded panel corners.
  for (const element of [document.documentElement, document.body, rootEl]) {
    element.style.background = 'transparent';
    element.style.backgroundColor = 'transparent';
    element.style.backgroundImage = 'none';
  }
  const runtimeEffectsEnabled = resolveRuntimePlan().petEnabled;
  const Surface = React.lazy(async () => ({
    default:
      view === 'pet-overlay'
        ? (await loaders.overlay()).PetOverlayWindow
        : (await loaders.panel()).PetMiniPanelWindow,
  }));

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <React.Suspense
          fallback={view === 'pet-mini-panel' ? (
            <div
              role="status"
              aria-live="polite"
              className="flex h-screen flex-col rounded-[14px] border border-border bg-background p-4 text-foreground"
            >
              <strong className="text-sm">Jarvis</strong>
              <span className="mt-3 text-sm text-muted-foreground">Loading Chat and Terminals…</span>
            </div>
          ) : null}
        >
          <Surface runtimeEffectsEnabled={runtimeEffectsEnabled} />
        </React.Suspense>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
