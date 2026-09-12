const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function mountLoader(root, { label, conceptName, onEnter }) {
  let frame = 0;
  let startedAt = 0;
  let value = 0;
  let ready = false;
  let destroyed = false;

  root.innerHTML = `
    <div class="loader-visual" aria-hidden="true">
      <span class="loader-orbit"></span>
      <span class="loader-seed"></span>
      <span class="loader-horizon"></span>
      <span class="loader-line"></span>
    </div>
    <div class="loader-copy">
      <span class="loader-brand">VibeSpace</span>
      <p class="loader-concept">${conceptName}</p>
      <p class="loader-label">${label}</p>
      <output class="loader-count" aria-live="polite">000</output>
      <div class="loader-progress" aria-hidden="true"><span></span></div>
    </div>
    <div class="loader-actions" aria-label="Entrance choices">
      <button class="loader-enter" type="button" data-mode="sound" disabled>Enter with sound</button>
      <button class="loader-enter loader-enter--quiet" type="button" data-mode="silent" disabled>Enter silently</button>
    </div>
    <button class="loader-skip" type="button">Skip readiness</button>
  `;

  const output = root.querySelector(".loader-count");
  const progress = root.querySelector(".loader-progress span");
  const actions = [...root.querySelectorAll(".loader-enter")];
  const skip = root.querySelector(".loader-skip");

  const paint = () => {
    const rounded = Math.round(value);
    output.value = String(rounded).padStart(3, "0");
    output.textContent = String(rounded).padStart(3, "0");
    progress.style.transform = `scaleX(${value / 100})`;
    root.style.setProperty("--loader-progress", String(value / 100));
  };

  const finish = () => {
    value = 100;
    ready = true;
    paint();
    root.dataset.ready = "true";
    root.querySelector(".loader-label").textContent = "The world is ready";
    actions.forEach((button) => {
      button.disabled = false;
    });
    actions[0].focus({ preventScroll: true });
  };

  const tick = (time) => {
    if (destroyed || ready) return;
    if (!startedAt) startedAt = time;
    const elapsed = time - startedAt;
    const linear = clamp(elapsed / 2350, 0, 1);
    const eased = 1 - Math.pow(1 - linear, 3);
    value = eased * 100;
    paint();
    if (linear >= 1) {
      finish();
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  const enter = (mode) => {
    if (!ready) finish();
    root.dataset.leaving = "true";
    window.setTimeout(() => {
      root.hidden = true;
      root.dispatchEvent(new CustomEvent("loader:entered", { detail: { mode } }));
      onEnter?.(mode);
    }, 620);
  };

  actions.forEach((button) => {
    button.addEventListener("click", () => enter(button.dataset.mode));
  });
  skip.addEventListener("click", finish);
  frame = requestAnimationFrame(tick);

  return {
    enter,
    skip: finish,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      root.replaceChildren();
    },
  };
}
