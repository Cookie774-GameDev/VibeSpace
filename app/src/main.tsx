import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted fonts (bundled by Vite). The app previously pulled these from
// fonts.googleapis.com, but the production CSP (style-src 'self') blocks that
// stylesheet in the installed build — every terminal then silently fell back
// to Courier New, which renders bitmap-like ("pixelated") on Windows. Bundling
// locally guarantees the real fonts load in production, offline, with no FOUT.
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
import { App } from './App';
import './styles/globals.css';
import './styles/vibespace-theme.css';
import './styles/origami-chat.css';
import './styles/monochrome-theme.css';
import './styles/sakura-theme.css';
import './styles/warm-theme.css';
import './styles/origami-theme.css';
import './features/workbench/registerCommandActions';
import { useUIStore } from './stores/ui';
import { applyThemeSyncToApplication, startThemeSync } from './features/appearance/themeSync';
import { resolveDevelopmentSurface } from './developmentSurface';
import { TaskbarUsageWindow } from './features/taskbar-usage/TaskbarUsageWindow';
import { startTaskbarUsageController } from './features/taskbar-usage/taskbarUsageController';
import { startRendererHeartbeat } from './rendererHeartbeat';
import { ColdStartIntroView } from './features/cold-start-intro';
import { startResourcePressureMonitor } from './stability/resourcePressure';

const devSurface = import.meta.env.DEV ? resolveDevelopmentSurface(window.location.search) : null;
const viewParam = new URLSearchParams(window.location.search).get('view');
const taskbarUsageView = viewParam === 'taskbar-usage';
const coldStartIntroView = viewParam === 'cold-start-intro';

const DevelopmentEntry =
  import.meta.env.DEV && devSurface !== null
    ? React.lazy(() => import('./developmentEntry'))
    : null;

if (devSurface === 'monochrome') {
  document.documentElement.dataset.theme = 'monochrome';
} else if (devSurface === 'sakura') {
  document.documentElement.dataset.theme = 'sakura';
} else if (!coldStartIntroView) {
  startThemeSync((theme) => {
    applyThemeSyncToApplication(theme, document, useUIStore);
  });
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element not found');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    {coldStartIntroView ? (
      <ColdStartIntroView />
    ) : taskbarUsageView ? (
      <TaskbarUsageWindow />
    ) : DevelopmentEntry && devSurface ? (
      <React.Suspense fallback={null}>
        <DevelopmentEntry surface={devSurface} />
      </React.Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);

const stopRendererHeartbeat = startRendererHeartbeat();
window.addEventListener('pagehide', stopRendererHeartbeat, { once: true });

if (!taskbarUsageView && !coldStartIntroView) {
  const stopResourcePressureMonitor = startResourcePressureMonitor();
  window.addEventListener('pagehide', stopResourcePressureMonitor, { once: true });
  startTaskbarUsageController();
}
