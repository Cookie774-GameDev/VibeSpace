import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const ENTRIES = {
  'first-contact': 'first-contact.html',
  'memory-forest': 'memory-forest.html',
  'machine-opera': 'machine-opera.html',
};

test('catalog defines three visually independent seven-act worlds', async () => {
  const { WORLD_ORDER, WORLDS, getWorld } = await import('../worlds.mjs');

  assert.deepEqual(WORLD_ORDER, Object.keys(ENTRIES));
  assert.equal(Object.keys(WORLDS).length, 3);
  assert.equal(new Set(WORLD_ORDER.map((id) => WORLDS[id].signature)).size, 3);
  assert.equal(new Set(WORLD_ORDER.map((id) => WORLDS[id].displayFont)).size, 3);

  for (const id of WORLD_ORDER) {
    const world = WORLDS[id];
    assert.equal(getWorld(id), world);
    assert.equal(world.acts.length, 7);
    assert.equal(world.assets.plates.length, 7);
    assert.equal(new Set(world.acts.map((act) => act.title)).size, 7);
    assert.match(world.downloadUrl, /releases\/latest$/);
  }

  assert.equal(getWorld('unknown'), WORLDS['first-contact']);
});

test('every full-screen entrypoint exposes the cinematic lifecycle', async () => {
  for (const [id, file] of Object.entries(ENTRIES)) {
    const html = await readFile(new URL(file, ROOT), 'utf8');

    assert.match(html, new RegExp(`<body[^>]+data-world="${id}"`));
    assert.match(html, /data-loader-progress>000%/);
    assert.match(html, /Enter with sound/);
    assert.match(html, /Enter silently/);
    assert.match(html, /id="world-canvas"/);
    assert.match(html, /class="plate-stack"/);
    assert.match(html, /runtime\/experience\.mjs/);
    assert.match(html, /experience\.css/);
  }
});

test('act resolution preserves both endpoints and reversible local progress', async () => {
  const { resolveAct } = await import('../runtime/math.mjs');

  assert.deepEqual(resolveAct(0, 7), { index: 0, local: 0 });
  assert.deepEqual(resolveAct(0.5, 7), { index: 3, local: 0.5 });
  assert.deepEqual(resolveAct(1, 7), { index: 6, local: 1 });
  assert.deepEqual(resolveAct(0.5, 7), resolveAct(0.5, 7));
});

test('progress tracker reaches 100 only after every unique critical item settles', async () => {
  const { createProgressTracker } = await import('../runtime/preload.mjs');
  const tracker = createProgressTracker(3);

  assert.equal(tracker.percent(), 0);
  assert.equal(tracker.complete('plate-1'), true);
  assert.equal(tracker.complete('plate-1'), false);
  assert.equal(tracker.percent(), 33);
  tracker.complete('plate-2');
  assert.equal(tracker.percent(), 67);
  tracker.complete('renderer');
  assert.equal(tracker.percent(), 100);
});

test('spring state converges without leaving bounded journey progress', async () => {
  const { createSpringState, stepSpring } = await import('../runtime/timeline.mjs');
  let state = createSpringState(0);

  for (let frame = 0; frame < 180; frame += 1) {
    state = stepSpring(state, 1, 1 / 60, {
      stiffness: 115,
      damping: 22,
    });
    assert.ok(state.value >= 0 && state.value <= 1);
  }

  assert.ok(Math.abs(state.value - 1) < 0.001);
});

test('timeline frames blend only into a valid neighboring cinematic plate', async () => {
  const { WORLDS } = await import('../worlds.mjs');
  const { computeTimelineFrame } = await import('../runtime/timeline.mjs');
  const world = WORLDS['memory-forest'];

  assert.deepEqual(computeTimelineFrame(0, world), {
    progress: 0,
    actIndex: 0,
    local: 0,
    plateA: 0,
    plateB: 1,
    blend: 0,
  });

  const finalFrame = computeTimelineFrame(1, world);
  assert.equal(finalFrame.actIndex, 6);
  assert.equal(finalFrame.plateA, 6);
  assert.equal(finalFrame.plateB, 6);
  assert.equal(finalFrame.blend, 1);
});

test('every declared cinematic asset exists inside the delivery budget', async () => {
  const { readFile, stat } = await import('node:fs/promises');
  const { WORLDS } = await import('../worlds.mjs');

  for (const world of Object.values(WORLDS)) {
    for (const relativePath of [...world.assets.plates, world.assets.texture]) {
      const url = new URL(`../${relativePath}`, import.meta.url);
      const info = await stat(url);
      const header = await readFile(url, { encoding: null, flag: 'r' });
      assert.ok(
        info.size > 4_096,
        `${relativePath} is too small to contain a final cinematic visual`,
      );
      assert.ok(
        info.size < 2_500_000,
        `${relativePath} exceeds the 2.5 MB delivery budget`,
      );
      assert.equal(header.subarray(0, 4).toString('ascii'), 'RIFF');
      assert.equal(header.subarray(8, 12).toString('ascii'), 'WEBP');
    }
  }
});

test('loop controller owns at most one animation frame through its lifecycle', async () => {
  const { createLoopController } = await import('../runtime/experience.mjs');
  let nextId = 0;
  const pending = new Map();
  const requestFrame = (callback) => {
    const id = ++nextId;
    pending.set(id, callback);
    return id;
  };
  const cancelFrame = (id) => pending.delete(id);
  const loop = createLoopController({
    requestFrame,
    cancelFrame,
    onFrame() {},
  });

  loop.start();
  loop.start();
  assert.equal(pending.size, 1);

  loop.pause();
  assert.equal(pending.size, 0);

  loop.resume();
  loop.resume();
  assert.equal(pending.size, 1);

  loop.destroy();
  assert.equal(pending.size, 0);
});

test('loader display climbs cinematically without outrunning real readiness', async () => {
  const { computeLoaderDisplay } = await import('../runtime/experience.mjs');

  assert.equal(computeLoaderDisplay(0, 100, 2200), 0);
  assert.ok(computeLoaderDisplay(350, 100, 2200) > 0);
  assert.ok(computeLoaderDisplay(350, 100, 2200) < 97);
  assert.equal(computeLoaderDisplay(2200, 100, 2200), 97);
  assert.ok(computeLoaderDisplay(1600, 20, 2200) <= 20);
  assert.ok(computeLoaderDisplay(10_000, 100, 2200) < 100);
});

test('plate presentation crossfades only neighboring scenes with bounded styles', async () => {
  const { WORLDS } = await import('../worlds.mjs');
  const { computePlatePresentation } = await import('../runtime/renderer.mjs');
  const world = WORLDS['machine-opera'];
  const presentation = computePlatePresentation(
    {
      progress: 0.55,
      actIndex: 3,
      local: 0.85,
      plateA: 3,
      plateB: 4,
      blend: 0.78,
    },
    world,
    { x: 0.7, y: -0.4 },
  );

  assert.equal(presentation.length, 7);
  assert.ok(presentation[3].opacity > 0);
  assert.ok(presentation[4].opacity > 0);
  assert.equal(
    presentation.filter(({ opacity }) => opacity > 0).length,
    2,
  );
  for (const style of presentation) {
    assert.ok(style.opacity >= 0 && style.opacity <= 1);
    assert.ok(style.scale >= 1 && style.scale <= 1.9);
    assert.ok(Math.abs(style.x) <= 8);
    assert.ok(Math.abs(style.y) <= 8);
  }
});

test('procedural score remains gesture-gated and destroyable', async () => {
  const { createWorldScore } = await import('../runtime/sound.mjs');
  let contextsCreated = 0;
  let contextClosed = false;
  const fakeContext = {
    currentTime: 0,
    destination: {},
    createGain() {
      return {
        gain: {
          value: 0,
          cancelScheduledValues() {},
          linearRampToValueAtTime() {},
          setValueAtTime() {},
        },
        connect() {},
      };
    },
    createDynamicsCompressor() {
      return { connect() {} };
    },
    createOscillator() {
      return {
        type: 'sine',
        frequency: { value: 0 },
        detune: { value: 0 },
        connect() {},
        start() {},
        stop() {},
      };
    },
    async resume() {},
    async close() {
      contextClosed = true;
    },
  };
  const score = createWorldScore('first-contact', {
    createContext() {
      contextsCreated += 1;
      return fakeContext;
    },
  });

  assert.equal(contextsCreated, 0);
  score.update(0.5, 0.02);
  assert.equal(contextsCreated, 0);
  await score.start();
  await score.start();
  assert.equal(contextsCreated, 1);
  score.setMuted(true);
  await score.destroy();
  assert.equal(contextClosed, true);
});

test('gallery links directly to the three full-screen worlds', async () => {
  const html = await readFile(new URL('index.html', ROOT), 'utf8');

  for (const file of Object.values(ENTRIES)) {
    assert.match(html, new RegExp(`href="${file}"`));
  }
  assert.equal((html.match(/class="world-portal"/g) || []).length, 3);
  assert.doesNotMatch(html, /iframe/);
  assert.match(html, /gallery\.css/);
  assert.match(html, /gallery\.mjs/);
});
