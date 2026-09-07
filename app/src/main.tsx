import { mountWithFeedback } from './bootstrapFeedback';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element not found');
}

const viewParam = new URLSearchParams(window.location.search).get('view');

if (viewParam === 'cold-start-intro') {
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
