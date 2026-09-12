import { clamp, lerp } from './math.mjs';

function activeOpacity(index, frame) {
  if (frame.plateA === frame.plateB) return index === frame.plateA ? 1 : 0;
  if (index === frame.plateA) return 1 - frame.blend;
  if (index === frame.plateB) return frame.blend;
  return 0;
}

export function computePlatePresentation(frame, world, pointer = { x: 0, y: 0 }) {
  return world.acts.map((act, index) => {
    const opacity = clamp(activeOpacity(index, frame), 0, 1);
    const camera = act.camera;
    const localDrift =
      index === frame.plateA ? frame.local : index === frame.plateB ? frame.blend : 0;
    const depth = camera.depth ?? 0.5;

    return {
      opacity,
      scale: clamp(camera.scale + localDrift * 0.045, 1, 1.9),
      x: clamp(camera.x + pointer.x * depth * 2.5, -8, 8),
      y: clamp(camera.y + pointer.y * depth * 1.8 - localDrift * 0.7, -8, 8),
      rotate: clamp(camera.rotate + pointer.x * 0.12, -1.5, 1.5),
      brightness: clamp(0.72 + opacity * 0.32, 0.72, 1.04),
    };
  });
}

function buildStage(world, stack, copyRoot) {
  stack.innerHTML = world.acts
    .map(
      (act, index) => `
        <figure class="plate" data-plate="${index}">
          <img
            src="${world.assets.plates[index]}"
            alt=""
            width="1920"
            height="1080"
            decoding="async"
            fetchpriority="${index < 2 ? 'high' : 'auto'}"
          >
        </figure>
      `,
    )
    .join('');

  copyRoot.innerHTML = world.acts
    .map(
      (act, index) => `
        <section class="act-card" data-act="${index}" aria-hidden="${index !== 0}">
          <div class="act-rule" aria-hidden="true"></div>
          <p class="act-eyebrow">${act.eyebrow}</p>
          <h${index === 0 ? '1' : '2'}>${act.title}</h${index === 0 ? '1' : '2'}>
          <p class="act-body">${act.body}</p>
          ${
            act.cta
              ? `<a class="act-cta" href="${world.downloadUrl}" tabindex="-1">${act.cta}<span aria-hidden="true">↗</span></a>`
              : ''
          }
        </section>
      `,
    )
    .join('');
}

function buildChrome(world, experience) {
  experience.insertAdjacentHTML(
    'afterbegin',
    `
      <header class="world-chrome">
        <a class="world-mark" href="index.html" aria-label="Return to all cinematic worlds">
          <span class="world-mark-glyph" aria-hidden="true">V/S</span>
          <span>VibeSpace</span>
        </a>
        <div class="world-index">
          <span>${world.number} / 03</span>
          <strong>${world.name}</strong>
        </div>
        <button class="sound-control" type="button" data-audio-toggle aria-pressed="false">
          <span class="sound-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <span data-audio-label>Sound off</span>
        </button>
      </header>
      <aside class="progress-instrument" aria-label="${world.instrument}">
        <div class="progress-readout">
          <span data-act-number>01</span>
          <span class="progress-divider">/</span>
          <span>07</span>
        </div>
        <div class="progress-track" aria-hidden="true">
          <i data-progress-fill></i>
          ${world.acts.map((_, index) => `<b style="--index:${index}"></b>`).join('')}
        </div>
        <p>${world.instrument}</p>
      </aside>
      <footer class="scene-cue">
        <span class="cue-line" aria-hidden="true"><i></i></span>
        <span data-scene-cue>${world.acts[0].cue}</span>
        <span data-scroll-percent>000</span>
      </footer>
      <div class="cinema-matte cinema-matte-top" aria-hidden="true"></div>
      <div class="cinema-matte cinema-matte-bottom" aria-hidden="true"></div>
      <div class="world-grain" aria-hidden="true"></div>
    `,
  );
}

function makeParticles(worldId, count = 90) {
  const seedOffset =
    worldId === 'first-contact' ? 17 : worldId === 'memory-forest' ? 43 : 79;
  return Array.from({ length: count }, (_, index) => {
    const seed = Math.sin((index + seedOffset) * 127.1) * 43758.5453;
    const random = seed - Math.floor(seed);
    const second = Math.sin((index + seedOffset) * 311.7) * 15731.743;
    const randomB = second - Math.floor(second);
    return {
      x: random,
      y: randomB,
      size: 0.35 + ((index * 17) % 11) / 10,
      phase: ((index * 29) % 100) / 100,
    };
  });
}

function createAtmosphere(canvas, world) {
  const context = canvas.getContext('2d', { alpha: true });
  const particles = makeParticles(world.id, world.id === 'memory-forest' ? 120 : 82);
  let width = 1;
  let height = 1;
  let ratio = 1;

  function resize() {
    ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function drawSignal(progress, time, velocity) {
    const centerX = width * (0.5 + Math.sin(progress * Math.PI * 1.7) * 0.055);
    const centerY = height * (0.48 - Math.cos(progress * Math.PI) * 0.025);
    const radius = Math.min(width, height) * (0.13 + progress * 0.15);
    context.save();
    context.translate(centerX, centerY);
    context.rotate(progress * 0.45);
    for (let ring = 0; ring < 4; ring += 1) {
      const pulse = Math.sin(time * 0.0007 + ring * 1.9 + progress * 12) * 0.5 + 0.5;
      context.beginPath();
      context.ellipse(
        0,
        0,
        radius * (1 + ring * 0.38 + pulse * 0.06),
        radius * (0.34 + ring * 0.1),
        ring * 0.23,
        0,
        Math.PI * 2,
      );
      context.strokeStyle = `rgba(108, 231, 223, ${0.045 + pulse * 0.055})`;
      context.lineWidth = ring === 0 ? 1.2 : 0.55;
      context.stroke();
    }
    context.restore();

    context.lineWidth = 0.6;
    for (const particle of particles) {
      const travel = (particle.y + progress * (0.45 + particle.phase) + time * 0.000012) % 1;
      const x = particle.x * width;
      const y = travel * height;
      const stretch = 3 + Math.min(18, Math.abs(velocity) * 900);
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + stretch * 0.2, y + stretch);
      context.strokeStyle = `rgba(228, 247, 243, ${0.035 + particle.phase * 0.1})`;
      context.stroke();
    }
  }

  function drawForest(progress, time, velocity) {
    const sway = Math.sin(time * 0.00035) * 9;
    context.lineCap = 'round';
    for (const particle of particles) {
      const x = particle.x * width + Math.sin(time * 0.0002 + particle.phase * 8) * 7;
      const y = ((particle.y - progress * 0.21 + 1) % 1) * height;
      const alpha = 0.035 + particle.phase * 0.11;
      context.fillStyle = `rgba(205, 231, 195, ${alpha})`;
      context.beginPath();
      context.arc(x, y, particle.size * (0.65 + progress), 0, Math.PI * 2);
      context.fill();
    }
    context.strokeStyle = `rgba(114, 229, 163, ${0.06 + Math.abs(velocity) * 2})`;
    context.lineWidth = 0.7;
    for (let root = 0; root < 7; root += 1) {
      const originX = width * (0.16 + root * 0.115);
      context.beginPath();
      context.moveTo(originX, height + 10);
      context.bezierCurveTo(
        originX + sway * (root % 2 ? 1 : -1),
        height * 0.68,
        width * (0.48 + Math.sin(root) * 0.12),
        height * (0.52 - progress * 0.2),
        width * (0.5 + Math.sin(root * 2.2) * 0.06),
        height * (0.34 - progress * 0.12),
      );
      context.stroke();
    }
  }

  function drawMachine(progress, time, velocity) {
    const margin = width * 0.045;
    const measureWidth = (width - margin * 2) / 7;
    context.strokeStyle = 'rgba(239, 236, 228, 0.085)';
    context.lineWidth = 0.7;
    for (let measure = 0; measure <= 7; measure += 1) {
      const x = margin + measure * measureWidth;
      context.beginPath();
      context.moveTo(x, height * 0.11);
      context.lineTo(x, height * 0.89);
      context.stroke();
    }
    const playhead = margin + progress * (width - margin * 2);
    context.strokeStyle = `rgba(223, 53, 31, ${0.38 + Math.abs(velocity) * 4})`;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(playhead, height * 0.08);
    context.lineTo(playhead, height * 0.92);
    context.stroke();
    for (const particle of particles.slice(0, 28)) {
      const x = margin + particle.x * (width - margin * 2);
      const rhythm = (time * 0.00008 + particle.phase + progress) % 1;
      const y = height * (0.2 + particle.y * 0.6);
      context.fillStyle = `rgba(18, 17, 15, ${0.1 + rhythm * 0.12})`;
      context.fillRect(x, y, 1 + particle.size, 7 + rhythm * 25);
    }
  }

  function draw(frame, time, velocity) {
    context.clearRect(0, 0, width, height);
    if (world.id === 'first-contact') {
      drawSignal(frame.progress, time, velocity);
    } else if (world.id === 'memory-forest') {
      drawForest(frame.progress, time, velocity);
    } else {
      drawMachine(frame.progress, time, velocity);
    }
  }

  resize();
  return {
    draw,
    resize,
    destroy() {
      context.clearRect(0, 0, width, height);
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}

export function createSceneRenderer({ world, experience, canvas, stack, copyRoot }) {
  buildStage(world, stack, copyRoot);
  buildChrome(world, experience);

  const plates = [...stack.querySelectorAll('[data-plate]')];
  const acts = [...copyRoot.querySelectorAll('[data-act]')];
  const progressFill = experience.querySelector('[data-progress-fill]');
  const actNumber = experience.querySelector('[data-act-number]');
  const cue = experience.querySelector('[data-scene-cue]');
  const percent = experience.querySelector('[data-scroll-percent]');
  const atmosphere = createAtmosphere(canvas, world);
  let previousAct = -1;

  function render(frame, pointer, time, velocity) {
    const styles = computePlatePresentation(frame, world, pointer);
    styles.forEach((style, index) => {
      const plate = plates[index];
      plate.style.setProperty('--plate-opacity', style.opacity.toFixed(4));
      plate.style.setProperty('--plate-x', `${style.x.toFixed(3)}%`);
      plate.style.setProperty('--plate-y', `${style.y.toFixed(3)}%`);
      plate.style.setProperty('--plate-scale', style.scale.toFixed(4));
      plate.style.setProperty('--plate-rotate', `${style.rotate.toFixed(3)}deg`);
      plate.style.setProperty('--plate-brightness', style.brightness.toFixed(3));
      plate.toggleAttribute('data-visible', style.opacity > 0.002);
    });

    if (previousAct !== frame.actIndex) {
      document.body.dataset.activeAct = String(frame.actIndex);
      acts.forEach((act, index) => {
        const active = index === frame.actIndex;
        act.classList.toggle('is-active', active);
        act.classList.toggle('is-past', index < frame.actIndex);
        act.setAttribute('aria-hidden', String(!active));
        const callToAction = act.querySelector('.act-cta');
        if (callToAction) callToAction.tabIndex = active ? 0 : -1;
      });
      actNumber.textContent = String(frame.actIndex + 1).padStart(2, '0');
      cue.textContent = world.acts[frame.actIndex].cue;
      previousAct = frame.actIndex;
    }

    experience.style.setProperty('--journey', frame.progress.toFixed(5));
    experience.style.setProperty('--velocity', clamp(Math.abs(velocity) * 40, 0, 1).toFixed(3));
    progressFill.style.transform = `scaleX(${frame.progress.toFixed(5)})`;
    percent.textContent = String(Math.round(frame.progress * 100)).padStart(3, '0');
    atmosphere.draw(frame, time, velocity);
  }

  function resize() {
    atmosphere.resize();
  }

  return {
    render,
    resize,
    plates,
    audioButton: experience.querySelector('[data-audio-toggle]'),
    destroy() {
      atmosphere.destroy();
      stack.replaceChildren();
      copyRoot.replaceChildren();
    },
  };
}
