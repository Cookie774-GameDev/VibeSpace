import { getConcept, PRICING, PRODUCT_BEATS } from "./content.mjs";
import { mountLoader } from "./loader.mjs";
import { createAmbientScore } from "./sound.mjs";

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const decorMarkup = `
  <div class="world-sky" aria-hidden="true">
    <span class="world-sun"></span>
    <span class="world-haze world-haze--a"></span>
    <span class="world-haze world-haze--b"></span>
  </div>
  <div class="mountain-world" aria-hidden="true">
    <span class="mountain-plane mountain-plane--far"></span>
    <span class="mountain-plane mountain-plane--middle"></span>
    <span class="mountain-plane mountain-plane--near"></span>
    <svg class="mountain-trail" viewBox="0 0 1200 700" preserveAspectRatio="none">
      <path d="M-40 655 C140 610 180 520 340 535 S520 430 650 455 S815 330 930 350 S1080 220 1260 118" />
    </svg>
    <span class="wildflower wildflower--one"></span>
    <span class="wildflower wildflower--two"></span>
    <span class="wildflower wildflower--three"></span>
  </div>
  <div class="desk-world" aria-hidden="true">
    <span class="desk-shadow"></span>
    <span class="paper-layer paper-layer--one"></span>
    <span class="paper-layer paper-layer--two"></span>
    <span class="paper-layer paper-layer--three"></span>
    <span class="desk-pencil"></span>
    <span class="desk-cup"></span>
    <span class="registration-mark registration-mark--a">+</span>
    <span class="registration-mark registration-mark--b">+</span>
  </div>
  <div class="garden-world" aria-hidden="true">
    <svg class="garden-branch" viewBox="0 0 1200 780" preserveAspectRatio="none">
      <path class="garden-stem" pathLength="1" d="M600 810 C585 680 650 610 594 510 C540 412 610 330 592 236 C580 168 620 108 604 20" />
      <path class="garden-stem garden-stem--left" pathLength="1" d="M603 604 C510 560 474 476 370 448 C288 426 240 360 170 330" />
      <path class="garden-stem garden-stem--right" pathLength="1" d="M588 478 C674 452 715 382 814 366 C900 352 954 274 1046 252" />
      <path class="garden-stem garden-stem--upper" pathLength="1" d="M592 315 C516 286 470 218 395 185" />
    </svg>
    <span class="garden-bloom garden-bloom--one"></span>
    <span class="garden-bloom garden-bloom--two"></span>
    <span class="garden-bloom garden-bloom--three"></span>
    <span class="garden-bloom garden-bloom--four"></span>
    <span class="garden-leaf garden-leaf--one"></span>
    <span class="garden-leaf garden-leaf--two"></span>
  </div>
  <div class="world-grain" aria-hidden="true"></div>
`;

const pricingMarkup = () => `
  <div class="pricing-panel" aria-label="Optional VibeSpace feature plans">
    <div class="access-ledger">
      <span>VibeSpace Access</span>
      <strong>$${PRICING.access}<small>/month</small></strong>
      <p>after a ${PRICING.trialDays}-day introductory trial</p>
    </div>
    <div class="plan-row">
      ${PRICING.plans
        .map(
          (plan) => `
            <article class="plan-card${plan.featured ? " plan-card--featured" : ""}" style="--plan-accent:${plan.accent}">
              ${plan.featured ? '<span class="plan-flag">Most room to explore</span>' : ""}
              <h3>${plan.name}</h3>
              <p class="plan-price">$${plan.price}<small>/mo</small></p>
              <p>${plan.note}</p>
            </article>
          `,
        )
        .join("")}
    </div>
    <p class="pricing-truth">${PRICING.note}</p>
  </div>
`;

const sceneMarkup = (beat, index, total) => {
  const isFinal = beat.id === "access";
  return `
    <section class="world-scene world-scene--${beat.id}" data-scene-index="${index}" data-align="${beat.align}" aria-labelledby="scene-title-${beat.id}">
      <div class="scene-coordinate" aria-hidden="true">
        <span>${escapeHtml(beat.sceneLabel)}</span>
        <span>${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</span>
      </div>
      <article class="scene-copy">
        <p class="scene-eyebrow"><span>${beat.number}</span>${escapeHtml(beat.eyebrow)}</p>
        <h2 id="scene-title-${beat.id}">${escapeHtml(beat.title)}</h2>
        <p class="scene-body">${escapeHtml(beat.body)}</p>
        <ul class="scene-tags" aria-label="${escapeHtml(beat.title)} details">
          ${beat.tags.map((tag) => `<li>${escapeHtml(tag)}</li>`).join("")}
        </ul>
        <div class="scene-actions">
          <button class="feature-marker" type="button" data-detail-id="${beat.id}" aria-haspopup="dialog">
            <span aria-hidden="true">+</span> Open field note
          </button>
          ${
            index < total - 1
              ? `<button class="scene-continue" type="button" data-goto="${index + 1}">Continue <span aria-hidden="true">↓</span></button>`
              : `<a class="scene-cta" href="https://github.com/Cookie774-GameDev/VibeSpace">View VibeSpace on GitHub <span aria-hidden="true">↗</span></a>`
          }
        </div>
      </article>
      <div class="product-composition">
        <figure class="product-window product-window--primary">
          <div class="product-window-bar" aria-hidden="true">
            <span></span><span></span><span></span><em>VibeSpace / ${escapeHtml(beat.eyebrow)}</em>
          </div>
          <img src="${beat.asset}" alt="${escapeHtml(beat.eyebrow)} in the authentic Warm VibeSpace interface" draggable="false" />
          <figcaption>Authentic Warm VibeSpace surface</figcaption>
        </figure>
        <figure class="product-window product-window--secondary">
          <img src="${beat.secondary}" alt="" draggable="false" />
        </figure>
        <button class="product-hotspot" type="button" data-detail-id="${beat.id}" aria-label="Learn more about ${escapeHtml(beat.eyebrow)}">
          <span></span>
        </button>
      </div>
      ${isFinal ? pricingMarkup() : ""}
      ${
        isFinal
          ? `
            <div class="final-note">
              <p>Local-first by design. Cloud only when you choose it.</p>
              <nav aria-label="Footer links">
                <a href="#product">Product</a>
                <a href="#trust">Trust</a>
                <a href="#pricing">Pricing</a>
                <a href="./index.html">Three directions</a>
              </nav>
            </div>
          `
          : ""
      }
    </section>
  `;
};

const shellMarkup = (concept) => `
  <a class="skip-link" href="#cinematic-stage">Skip to the experience</a>
  <div class="desktop-notice" role="note">
    <strong>This cinematic reference is composed for desktop.</strong>
    <span>Open it at 1100px or wider to see the full spatial choreography.</span>
  </div>
  <div class="readiness-loader" role="dialog" aria-modal="true" aria-label="${escapeHtml(concept.name)} readiness"></div>
  <header class="site-header">
    <a class="brand-mark" href="./index.html" aria-label="VibeSpace cinematic directions">
      <span>V</span><strong>VibeSpace</strong>
    </a>
    <nav class="site-nav" aria-label="Product">
      <button type="button" data-goto="0">Product</button>
      <button type="button" data-goto="2">Agents</button>
      <button type="button" data-goto="5">Skills</button>
      <button type="button" data-goto="3">Workflows</button>
      <button type="button" data-goto="7">Pricing</button>
    </nav>
    <div class="header-actions">
      <button class="sound-toggle" type="button" aria-pressed="false"><span aria-hidden="true">◌</span> Sound off</button>
      <a class="gallery-return" href="./index.html">All directions</a>
    </div>
  </header>
  <main id="cinematic-stage" class="cinematic-stage" tabindex="-1">
    ${decorMarkup}
    <div class="concept-title" aria-hidden="true">
      <span>${concept.number}</span>
      <strong>${escapeHtml(concept.shortName)}</strong>
    </div>
    <div class="scene-stack">
      ${concept.beats.map((beat, index) => sceneMarkup(beat, index, concept.beats.length)).join("")}
    </div>
    <nav class="progress-rail" aria-label="Story chapters">
      <div class="progress-rail__line"><span></span></div>
      ${concept.beats
        .map(
          (beat, index) => `
            <button type="button" data-goto="${index}" aria-label="${index + 1}. ${escapeHtml(beat.eyebrow)}">
              <span>${String(index + 1).padStart(2, "0")}</span>
              <em>${escapeHtml(beat.sceneLabel)}</em>
            </button>
          `,
        )
        .join("")}
    </nav>
    <div class="world-counter" aria-live="polite">
      <span class="world-counter__current">01</span>
      <span class="world-counter__rule"></span>
      <span>${String(concept.beats.length).padStart(2, "0")}</span>
    </div>
    <p class="scroll-cue"><span aria-hidden="true"></span> Scroll to travel</p>
  </main>
  <div class="scroll-track" aria-hidden="true">
    ${concept.beats.map((beat) => `<span id="${beat.id}" class="scroll-marker"></span>`).join("")}
  </div>
  <aside class="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title" hidden>
    <button class="detail-drawer__close" type="button" aria-label="Close field note">×</button>
    <p class="detail-drawer__eyebrow">VibeSpace field note</p>
    <h2 id="detail-title"></h2>
    <p class="detail-drawer__body"></p>
    <ul class="detail-drawer__tags"></ul>
    <div class="detail-drawer__meter" aria-hidden="true"><span></span></div>
  </aside>
`;

export function mountWorld(root, conceptId) {
  const concept = getConcept(conceptId);
  const score = createAmbientScore();
  const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = reducedQuery.matches;
  let target = 0;
  let current = 0;
  let frame = 0;
  let lastActive = -1;
  let entered = false;
  let lastFocus = null;
  let destroyed = false;

  document.body.dataset.concept = concept.id;
  document.documentElement.classList.add("world-locked");
  root.className = "world-root";
  root.dataset.concept = concept.id;
  root.innerHTML = shellMarkup(concept);

  const scenes = [...root.querySelectorAll(".world-scene")];
  const railButtons = [...root.querySelectorAll(".progress-rail button")];
  const gotoButtons = [...root.querySelectorAll("[data-goto]")];
  const counter = root.querySelector(".world-counter__current");
  const drawer = root.querySelector(".detail-drawer");
  const drawerTitle = drawer.querySelector("#detail-title");
  const drawerBody = drawer.querySelector(".detail-drawer__body");
  const drawerTags = drawer.querySelector(".detail-drawer__tags");
  const drawerClose = drawer.querySelector(".detail-drawer__close");
  const soundToggle = root.querySelector(".sound-toggle");
  const loaderRoot = root.querySelector(".readiness-loader");

  const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  const gotoScene = (index, behavior = reducedMotion ? "auto" : "smooth") => {
    const safe = clamp(Number(index), 0, scenes.length - 1);
    window.scrollTo({
      top: (safe / (scenes.length - 1)) * maxScroll(),
      behavior,
    });
  };

  const updateActive = (index) => {
    if (lastActive === index) return;
    lastActive = index;
    counter.textContent = String(index + 1).padStart(2, "0");
    scenes.forEach((scene, sceneIndex) => {
      const active = sceneIndex === index;
      scene.dataset.active = String(active);
      scene.setAttribute("aria-hidden", String(!active));
    });
    railButtons.forEach((button, buttonIndex) => {
      if (buttonIndex === index) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
  };

  const render = () => {
    if (destroyed) return;
    current += (target - current) * (reducedMotion ? 1 : 0.105);
    if (Math.abs(target - current) < 0.00005) current = target;
    const storyPosition = current * (scenes.length - 1);
    const activeIndex = clamp(Math.round(storyPosition), 0, scenes.length - 1);
    root.style.setProperty("--world-progress", current.toFixed(5));
    root.style.setProperty("--story-position", storyPosition.toFixed(5));

    scenes.forEach((scene, index) => {
      const distance = storyPosition - index;
      const activity = clamp(1 - Math.abs(distance));
      scene.style.setProperty("--scene-distance", distance.toFixed(5));
      scene.style.setProperty("--scene-active", activity.toFixed(5));
      scene.style.setProperty("--scene-abs", Math.abs(distance).toFixed(5));
    });
    updateActive(activeIndex);
    score.setProgress(current);
    frame = requestAnimationFrame(render);
  };

  const onScroll = () => {
    if (!entered) return;
    target = clamp(window.scrollY / maxScroll());
  };

  const onPointerMove = (event) => {
    const x = event.clientX / Math.max(1, window.innerWidth) - 0.5;
    const y = event.clientY / Math.max(1, window.innerHeight) - 0.5;
    root.style.setProperty("--pointer-x", x.toFixed(4));
    root.style.setProperty("--pointer-y", y.toFixed(4));
    root.style.setProperty("--pointer-px", `${event.clientX}px`);
    root.style.setProperty("--pointer-py", `${event.clientY}px`);
  };

  const openDetail = (id, trigger) => {
    const beat = PRODUCT_BEATS.find((candidate) => candidate.id === id);
    if (!beat) return;
    lastFocus = trigger;
    drawerTitle.textContent = beat.detailTitle;
    drawerBody.textContent = beat.detailBody;
    drawerTags.innerHTML = beat.tags.map((tag) => `<li>${escapeHtml(tag)}</li>`).join("");
    drawer.hidden = false;
    requestAnimationFrame(() => {
      drawer.dataset.open = "true";
      drawerClose.focus({ preventScroll: true });
    });
  };

  const closeDetail = () => {
    drawer.dataset.open = "false";
    window.setTimeout(() => {
      drawer.hidden = true;
      lastFocus?.focus({ preventScroll: true });
    }, reducedMotion ? 0 : 320);
  };

  const onKeyDown = (event) => {
    if (!drawer.hidden && event.key === "Escape") {
      event.preventDefault();
      closeDetail();
      return;
    }
    const editing = event.target.closest("input, textarea, select, [contenteditable='true']");
    if (editing) return;
    const active = Math.round(current * (scenes.length - 1));
    if (event.key === "PageDown" || event.key === "ArrowDown") {
      event.preventDefault();
      gotoScene(active + 1);
    } else if (event.key === "PageUp" || event.key === "ArrowUp") {
      event.preventDefault();
      gotoScene(active - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      gotoScene(0);
    } else if (event.key === "End") {
      event.preventDefault();
      gotoScene(scenes.length - 1);
    } else if (/^[1-8]$/.test(event.key)) {
      event.preventDefault();
      gotoScene(Number(event.key) - 1);
    }
  };

  gotoButtons.forEach((button) => {
    button.addEventListener("click", () => gotoScene(button.dataset.goto));
  });
  root.querySelectorAll("[data-detail-id]").forEach((button) => {
    button.addEventListener("click", () => openDetail(button.dataset.detailId, button));
  });
  drawerClose.addEventListener("click", closeDetail);
  drawer.addEventListener("click", (event) => {
    if (event.target === drawer) closeDetail();
  });
  soundToggle.addEventListener("click", async () => {
    const enabled = await score.toggle();
    soundToggle.setAttribute("aria-pressed", String(enabled));
    soundToggle.innerHTML = `<span aria-hidden="true">${enabled ? "●" : "◌"}</span> Sound ${enabled ? "on" : "off"}`;
  });

  mountLoader(loaderRoot, {
    label: concept.loaderLabel,
    conceptName: concept.name,
    onEnter: async (mode) => {
      entered = true;
      document.documentElement.classList.remove("world-locked");
      root.dataset.entered = "true";
      if (mode === "sound") {
        const enabled = await score.unlock();
        soundToggle.setAttribute("aria-pressed", String(enabled));
        soundToggle.innerHTML = `<span aria-hidden="true">●</span> Sound on`;
      }
      onScroll();
      root.querySelector(".cinematic-stage").focus({ preventScroll: true });
    },
  });

  const onReducedChange = (event) => {
    reducedMotion = event.matches;
    root.dataset.reducedMotion = String(reducedMotion);
  };
  reducedQuery.addEventListener?.("change", onReducedChange);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onScroll, { passive: true });
  updateActive(0);
  frame = requestAnimationFrame(render);

  return {
    gotoScene,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      reducedQuery.removeEventListener?.("change", onReducedChange);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onScroll);
      score.destroy();
      root.replaceChildren();
    },
  };
}
