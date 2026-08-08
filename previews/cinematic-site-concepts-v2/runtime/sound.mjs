import { clamp, lerp } from './math.mjs';

const SCORE_SETTINGS = {
  'first-contact': {
    frequencies: [43.65, 65.41, 98],
    types: ['sine', 'triangle', 'sine'],
    gains: [0.11, 0.045, 0.024],
    movement: 1.42,
  },
  'memory-forest': {
    frequencies: [55, 82.41, 110],
    types: ['sine', 'sine', 'triangle'],
    gains: [0.075, 0.038, 0.018],
    movement: 1.19,
  },
  'machine-opera': {
    frequencies: [73.42, 110, 146.83],
    types: ['triangle', 'square', 'sine'],
    gains: [0.052, 0.012, 0.022],
    movement: 1.62,
  },
};

function setAudioParam(param, value, context, duration = 0.08) {
  const now = context.currentTime;
  if (typeof param.cancelScheduledValues === 'function') {
    param.cancelScheduledValues(now);
  }
  if (typeof param.setValueAtTime === 'function') {
    param.setValueAtTime(param.value, now);
  }
  if (typeof param.linearRampToValueAtTime === 'function') {
    param.linearRampToValueAtTime(value, now + duration);
  } else {
    param.value = value;
  }
}

export function createWorldScore(
  worldId,
  {
    createContext = () =>
      new (window.AudioContext || window.webkitAudioContext)(),
  } = {},
) {
  const settings = SCORE_SETTINGS[worldId] ?? SCORE_SETTINGS['first-contact'];
  let context = null;
  let master = null;
  let nodes = [];
  let started = false;
  let muted = false;
  let destroyed = false;
  let requestedProgress = 0;
  let requestedVelocity = 0;

  function buildGraph() {
    master = context.createGain();
    const compressor = context.createDynamicsCompressor();
    master.gain.value = 0;
    compressor.connect(master);
    master.connect(context.destination);

    nodes = settings.frequencies.map((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = settings.types[index];
      oscillator.frequency.value = frequency;
      oscillator.detune.value = index === 1 ? -7 : index === 2 ? 5 : 0;
      gain.gain.value = settings.gains[index];
      oscillator.connect(gain);
      gain.connect(compressor);
      oscillator.start();
      return { oscillator, gain, base: frequency, index };
    });
  }

  async function start() {
    if (destroyed || started) return;
    context = createContext();
    buildGraph();
    await context.resume();
    started = true;
    setAudioParam(master.gain, muted ? 0 : 0.64, context, 1.4);
    update(requestedProgress, requestedVelocity);
  }

  function update(progress, velocity) {
    requestedProgress = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
    requestedVelocity = clamp(
      Number.isFinite(velocity) ? velocity : 0,
      -0.08,
      0.08,
    );
    if (!started || destroyed) return;

    const energy = clamp(Math.abs(requestedVelocity) * 18, 0, 1);
    nodes.forEach(({ oscillator, gain, base, index }) => {
      const harmonicTravel =
        1 + requestedProgress * (settings.movement - 1) * (0.48 + index * 0.24);
      const pulse = 1 + Math.sin(requestedProgress * Math.PI * (3 + index)) * 0.015;
      setAudioParam(
        oscillator.frequency,
        base * harmonicTravel * pulse,
        context,
        0.12,
      );
      setAudioParam(
        gain.gain,
        settings.gains[index] * lerp(0.7, 1.35, energy),
        context,
        0.09,
      );
    });
  }

  function setMuted(nextMuted) {
    muted = Boolean(nextMuted);
    if (!started || destroyed) return;
    setAudioParam(master.gain, muted ? 0 : 0.64, context, 0.38);
  }

  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const { oscillator } of nodes) {
      try {
        oscillator.stop();
      } catch {
        // A stopped oscillator is already silent.
      }
    }
    nodes = [];
    if (context) await context.close();
    context = null;
    master = null;
    started = false;
  }

  return {
    start,
    update,
    setMuted,
    destroy,
    get started() {
      return started;
    },
  };
}
