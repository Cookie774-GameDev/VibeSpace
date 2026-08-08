import { getWorld } from '../worlds.mjs';
import { clamp, lerp } from './math.mjs';
import { preloadCritical } from './preload.mjs';
import { createSceneRenderer } from './renderer.mjs';
import {
  computeTimelineFrame,
  createSpringState,
  stepSpring,
} from './timeline.mjs';

export function createLoopController({
  requestFrame,
  cancelFrame,
  onFrame,
}) {
  let frameId = 0;
  let running = false;
  let destroyed = false;

  const tick = (time) => {
    frameId = 0;
    if (!running || destroyed) return;
    onFrame(time);
    if (running && !destroyed) frameId = requestFrame(tick);
  };

  const start = () => {
    if (running || destroyed) return;
    running = true;
    frameId = requestFrame(tick);
  };

  const pause = () => {
    running = false;
    if (frameId) cancelFrame(frameId);
    frameId = 0;
  };

  return {
    start,
    resume: start,
    pause,
    destroy() {
      pause();
      destroyed = true;
    },
    get running() {
      return running;
    },
  };
}

export function computeLoaderDisplay(
  elapsedMilliseconds,
  actualPercent,
  minimumDuration = 2200,
) {
  const elapsed = Math.max(0, Number.isFinite(elapsedMilliseconds) ? elapsedMilliseconds : 0);
  const duration = Math.max(1, minimumDuration);
  const timeProgress = clamp(elapsed / duration, 0, 1);
  const authoredCeiling = 97 * (1 - Math.pow(1 - timeProgress, 2.2));
  const readinessCeiling = clamp(
    Number.isFinite(actualPercent) ? actualPercent : 0,
    0,
    97,
  );
  return Math.min(authoredCeiling, readinessCeiling);
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function setLoaderProgress(loader, output, value) {
  const bounded = clamp(Math.round(value), 0, 100);
  output.value = `${String(bounded).padStart(3, '0')}%`;
  output.textContent = output.value;
  loader.style.setProperty('--load-progress', `${bounded}%`);
}

async function finishLoader(loader, output, from) {
  const duration = 480;
  const started = performance.now();
  await new Promise((resolve) => {
    const animate = (time) => {
      const local = clamp((time - started) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - local, 3);
      setLoaderProgress(loader, output, lerp(from, 100, eased));
      if (local < 1) requestAnimationFrame(animate);
      else resolve();
    };
    requestAnimationFrame(animate);
  });
}

function scrollTarget() {
  const available = document.documentElement.scrollHeight - window.innerHeight;
  return available <= 0 ? 0 : clamp(window.scrollY / available, 0, 1);
}

async function bootstrapExperience() {
  const world = getWorld(document.body.dataset.world);
  const loader = document.querySelector('[data-loader]');
  const loaderLabel = document.querySelector('[data-loader-label]');
  const loaderOutput = document.querySelector('[data-loader-progress]');
  const gate = document.querySelector('[data-entry-gate]');
  const experience = document.querySelector('[data-experience]');
  const canvas = document.querySelector('#world-canvas');
  const stack = document.querySelector('[data-plate-stack]');
  const copyRoot = document.querySelector('[data-act-copy]');
  const enterSound = document.querySelector('[data-enter-sound]');
  const enterSilent = document.querySelector('[data-enter-silent]');
  const renderer = createSceneRenderer({
    world,
    experience,
    canvas,
    stack,
    copyRoot,
  });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let target = 0;
  let spring = createSpringState(0);
  let pointer = { x: 0, y: 0 };
  let pointerTarget = { x: 0, y: 0 };
  let lastTime = performance.now();
  let entered = false;
  let score = null;

  loaderLabel.textContent = world.loader.label;
  gate.querySelector('p').textContent = world.loader.complete;

  const loop = createLoopController({
    requestFrame: requestAnimationFrame,
    cancelFrame: cancelAnimationFrame,
    onFrame(time) {
      const delta = clamp((time - lastTime) / 1000, 0, 1 / 20);
      lastTime = time;
      target = scrollTarget();
      if (reducedMotion.matches) {
        spring = { value: target, velocity: 0 };
        pointer = { x: 0, y: 0 };
      } else {
        spring = stepSpring(spring, target, delta);
        pointer.x = lerp(pointer.x, pointerTarget.x, 1 - Math.exp(-delta * 7));
        pointer.y = lerp(pointer.y, pointerTarget.y, 1 - Math.exp(-delta * 7));
      }
      const frame = computeTimelineFrame(spring.value, world);
      renderer.render(frame, pointer, time, spring.velocity);
      score?.update(frame.progress, spring.velocity);
    },
  });

  const loaderDuration = 2200;
  const loaderStarted = performance.now();
  const minimumLoader = delay(loaderDuration);
  let actualProgress = 0;
  let displayedProgress = 0;
  let loaderFrameId = 0;
  let loading = true;
  const animateLoader = (time) => {
    displayedProgress = computeLoaderDisplay(
      time - loaderStarted,
      actualProgress,
      loaderDuration,
    );
    setLoaderProgress(loader, loaderOutput, displayedProgress);
    if (loading) loaderFrameId = requestAnimationFrame(animateLoader);
  };
  loaderFrameId = requestAnimationFrame(animateLoader);

  try {
    const preload = preloadCritical({
      images: world.assets.plates,
      fonts: document.fonts?.ready,
      rendererReady: Promise.resolve(renderer),
      onProgress(value) {
        actualProgress = value;
      },
    });
    await Promise.all([preload, minimumLoader]);
    loading = false;
    cancelAnimationFrame(loaderFrameId);
    displayedProgress = computeLoaderDisplay(
      loaderDuration,
      actualProgress,
      loaderDuration,
    );
    setLoaderProgress(loader, loaderOutput, displayedProgress);
    await finishLoader(loader, loaderOutput, displayedProgress);
  } catch (error) {
    loading = false;
    cancelAnimationFrame(loaderFrameId);
    console.error('Cinematic preload failed.', error);
    loader.dataset.error = 'true';
    loaderLabel.textContent = world.loader.retry;
    loaderOutput.textContent = 'ERR';
    loader.addEventListener('click', () => window.location.reload(), { once: true });
    return;
  }

  loader.classList.add('is-complete');
  await delay(650);
  loader.hidden = true;
  gate.hidden = false;
  requestAnimationFrame(() => gate.classList.add('is-visible'));
  renderer.render(computeTimelineFrame(0, world), pointer, performance.now(), 0);

  async function enter({ withSound }) {
    if (entered) return;
    entered = true;
    document.body.dataset.entered = 'true';
    gate.classList.remove('is-visible');
    gate.setAttribute('aria-hidden', 'true');
    await delay(700);
    gate.hidden = true;
    window.scrollTo({ top: 0, behavior: 'instant' });
    lastTime = performance.now();
    loop.start();
    if (withSound) {
      const { createWorldScore } = await import('./sound.mjs');
      score = createWorldScore(world.id);
      await score.start();
      renderer.audioButton.setAttribute('aria-pressed', 'true');
      renderer.audioButton.querySelector('[data-audio-label]').textContent = 'Sound on';
      document.body.dataset.sound = 'on';
    }
  }

  enterSound.addEventListener('click', () => enter({ withSound: true }));
  enterSilent.addEventListener('click', () => enter({ withSound: false }));
  renderer.audioButton.addEventListener('click', async () => {
    if (!score) {
      const { createWorldScore } = await import('./sound.mjs');
      score = createWorldScore(world.id);
      await score.start();
    }
    const muted = renderer.audioButton.getAttribute('aria-pressed') === 'true';
    score.setMuted(muted);
    renderer.audioButton.setAttribute('aria-pressed', String(!muted));
    renderer.audioButton.querySelector('[data-audio-label]').textContent = muted
      ? 'Sound off'
      : 'Sound on';
    document.body.dataset.sound = muted ? 'off' : 'on';
  });

  const handlePointer = (event) => {
    pointerTarget = {
      x: clamp((event.clientX / window.innerWidth - 0.5) * 2, -1, 1),
      y: clamp((event.clientY / window.innerHeight - 0.5) * 2, -1, 1),
    };
  };
  const handleVisibility = () => {
    if (!entered) return;
    if (document.hidden) loop.pause();
    else {
      lastTime = performance.now();
      loop.resume();
    }
  };
  const handlePageHide = () => {
    loop.destroy();
    score?.destroy();
    renderer.destroy();
    window.removeEventListener('pointermove', handlePointer);
    window.removeEventListener('resize', renderer.resize);
    document.removeEventListener('visibilitychange', handleVisibility);
  };

  window.addEventListener('pointermove', handlePointer);
  window.addEventListener('resize', renderer.resize);
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('pagehide', handlePageHide, { once: true });
}

if (typeof document !== 'undefined') {
  bootstrapExperience().catch((error) => {
    console.error('The cinematic world could not start.', error);
  });
}
