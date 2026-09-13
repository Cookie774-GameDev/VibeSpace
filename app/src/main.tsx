import { mountWithFeedback } from './bootstrapFeedback';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element not found');
}

const viewParam = new URLSearchParams(window.location.search).get('view');

if (viewParam === 'dictation') {
  // This native window is only 120×30: never load workspace-sized feedback,
  // account gates, or the main app's error panel into it.
  document.documentElement.style.background = 'transparent';
  document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden';
  const status = document.createElement('button');
  status.textContent = 'Starting voice…';
  status.style.cssText =
    'width:120px;height:30px;border:0;border-radius:999px;background:#f7eddf;color:#684d3c;font:11px system-ui';
  rootEl.replaceChildren(status);
  void import('./bootstrapDictation')
    .then(({ mountDictation }) => {
      mountDictation(rootEl);
    })
    .catch(() => {
      status.textContent = 'Retry voice';
      status.onclick = () => window.location.reload();
      rootEl.replaceChildren(status);
    });
} else if (viewParam === 'cold-start-intro') {
  void import('./bootstrapIntro').then(({ mountColdStartIntro }) => {
    mountColdStartIntro(rootEl);
  });
} else if (viewParam === 'pet-overlay' || viewParam === 'pet-mini-panel') {
  void import('./bootstrapPet').then(({ mountPetSurface }) => {
    mountPetSurface(rootEl, viewParam);
  });
} else {
  void mountWithFeedback(
    rootEl,
    async () => {
      const { mountApp } = await import('./bootstrapApp');
      mountApp(rootEl);
    },
    () => window.location.reload(),
  );
}
