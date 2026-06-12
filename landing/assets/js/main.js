/* VibeSpace — vibespaceos.com
   Vanilla JS, no dependencies.
   1) Page chrome: reveals, copy buttons, nav, progress, scrollspy…
   2) Interactive app window: 3D stage, view switching, live chat
      with Jarvis, animated terminal panes with focus mode, voice
      previews with a tiny WebAudio blip. */

(() => {
  "use strict";

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ----------------------------- year ----------------------------- */
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  /* ------------------------- scroll reveal ------------------------ */
  const revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reducedMotion) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("is-in"));
  }

  /* ------------------------ scroll progress ----------------------- */
  const progress = document.getElementById("progress");
  if (progress) {
    let ticking = false;
    const update = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
      ticking = false;
    };
    window.addEventListener(
      "scroll",
      () => {
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(update);
        }
      },
      { passive: true }
    );
    update();
  }

  /* --------------------------- nav menu --------------------------- */
  const burger = document.getElementById("navBurger");
  const links = document.getElementById("navLinks");
  if (burger && links) {
    burger.addEventListener("click", () => {
      const open = links.classList.toggle("is-open");
      burger.setAttribute("aria-expanded", String(open));
    });
    links.addEventListener("click", (e) => {
      if (e.target.closest("a")) {
        links.classList.remove("is-open");
        burger.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ------------------------- copy buttons ------------------------- */
  const toast = document.getElementById("toast");
  let toastTimer;
  const showToast = (msg) => {
    if (!toast) return;
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 2200);
  };

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy");
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      btn.classList.add("is-copied");
      showToast("Install command copied");
      setTimeout(() => btn.classList.remove("is-copied"), 1800);
    });
  });

  /* ------------------------- scrollspy ---------------------------- */
  const navAnchors = [...document.querySelectorAll('.nav__links a[href^="#"]')]
    .filter((a) => a.getAttribute("href").length > 1 && !a.classList.contains("btn"));
  const spied = navAnchors
    .map((a) => document.querySelector(a.getAttribute("href")))
    .filter(Boolean);
  if (spied.length && "IntersectionObserver" in window) {
    const setActive = (id) =>
      navAnchors.forEach((a) => a.classList.toggle("is-active", a.getAttribute("href") === "#" + id));
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => en.isIntersecting && setActive(en.target.id)),
      { rootMargin: "-30% 0px -60% 0px" }
    );
    spied.forEach((s) => io.observe(s));
  }

  /* ------------------ spotlight glow on cards --------------------- */
  if (finePointer) {
    document.querySelectorAll(".cell, .plan").forEach((card) => {
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${e.clientX - r.left}px`);
        card.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    });
  }

  /* ------------------------- 3D tilt cards ------------------------ */
  if (finePointer && !reducedMotion) {
    const MAX_DEG = 4.5;
    document.querySelectorAll(".cell, .plan").forEach((card) => {
      let raf = 0;
      card.addEventListener("pointermove", (e) => {
        if (!card.classList.contains("is-in")) return;
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          card.style.transition = "transform 0.12s ease-out, border-color 0.3s, box-shadow 0.3s";
          card.style.transform =
            `perspective(900px) rotateX(${(-py * MAX_DEG).toFixed(2)}deg) ` +
            `rotateY(${(px * MAX_DEG).toFixed(2)}deg) translateY(-2px)`;
        });
      });
      card.addEventListener("pointerleave", () => {
        cancelAnimationFrame(raf);
        card.style.transition = "transform 0.55s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.3s, box-shadow 0.3s";
        card.style.transform = "";
      });
    });
  }

  /* --------------------- magnetic buttons ------------------------- */
  if (finePointer && !reducedMotion) {
    document.querySelectorAll(".hero__actions .btn, .dl__buttons .btn").forEach((btn) => {
      btn.addEventListener("pointermove", (e) => {
        const r = btn.getBoundingClientRect();
        const x = (e.clientX - r.left - r.width / 2) * 0.16;
        const y = (e.clientY - r.top - r.height / 2) * 0.28;
        btn.style.transform = `translate(${x.toFixed(1)}px, ${(y - 2).toFixed(1)}px)`;
      });
      btn.addEventListener("pointerleave", () => {
        btn.style.transform = "";
      });
    });
  }

  /* ------------------ count-up plan numbers ----------------------- */
  if (!reducedMotion && "IntersectionObserver" in window) {
    const parsed = [];
    document.querySelectorAll(".plan__price, .plan__list strong").forEach((el) => {
      const node = el.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) return;
      const m = node.textContent.match(/^([^\d]*)([\d,]+)(.*)$/);
      if (!m) return;
      parsed.push({ el, node, prefix: m[1], value: parseInt(m[2].replace(/,/g, ""), 10), suffix: m[3] });
    });
    const animate = (t) => {
      const dur = 1100;
      const t0 = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        t.node.textContent = t.prefix + Math.round(t.value * eased).toLocaleString("en-US") + t.suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        const t = parsed.find((x) => x.el === en.target);
        if (t) animate(t);
      }
    }, { threshold: 0.6 });
    parsed.forEach((t) => io.observe(t.el));
  }

  /* ----------------------- back to top ---------------------------- */
  const toTop = document.getElementById("toTop");
  if (toTop) {
    let ticking = false;
    const onScroll = () => {
      toTop.classList.toggle("is-show", window.scrollY > 700);
      ticking = false;
    };
    window.addEventListener("scroll", () => {
      if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
    }, { passive: true });
    onScroll();
    toTop.addEventListener("click", () =>
      window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" })
    );
  }

  /* ================================================================
     INTERACTIVE APP WINDOW
     ================================================================ */
  const stage = document.getElementById("stage");
  const aw = document.getElementById("appWindow");
  if (!stage || !aw) return;

  /* ------------- 3D pose: sideways until you engage --------------- */
  if (finePointer && !reducedMotion) {
    let leaveTimer;
    aw.addEventListener("pointerenter", () => {
      clearTimeout(leaveTimer);
      stage.classList.add("is-flat");
    });
    aw.addEventListener("pointerleave", () => {
      leaveTimer = setTimeout(() => stage.classList.remove("is-flat"), 700);
    });
    /* subtle living tilt while flat */
    aw.addEventListener("pointermove", (e) => {
      if (!stage.classList.contains("is-flat")) return;
      const r = aw.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      aw.style.transform = `rotateY(${(px * 2.4).toFixed(2)}deg) rotateX(${(-py * 1.8).toFixed(2)}deg)`;
    });
    aw.addEventListener("pointerleave", () => { aw.style.transform = ""; });
  } else {
    stage.classList.add("is-flat");
  }

  /* ---------------------- view switching -------------------------- */
  const crumb = document.getElementById("awCrumb");
  const items = aw.querySelectorAll(".aw__item");
  const views = aw.querySelectorAll(".aw__view");
  const VIEW_NAMES = { chat: "Chat", term: "Terminal", voice: "Voice" };
  items.forEach((item) => {
    item.addEventListener("click", () => {
      const v = item.dataset.view;
      items.forEach((i) => i.classList.toggle("is-on", i === item));
      views.forEach((vw) => vw.classList.toggle("is-on", vw.dataset.view === v));
      if (crumb) crumb.textContent = VIEW_NAMES[v] || v;
    });
  });

  /* =========================== CHAT =============================== */
  const chatScroll = document.getElementById("chatScroll");
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");
  const chatChips = document.getElementById("chatChips");

  const GENERIC = [
    "On it. I&rsquo;ve pinned that to your context map so every agent in this workspace knows about it — nothing gets lost between sessions.",
    "Done. And because memory here is persistent, I&rsquo;ll still remember this conversation next week — or next month.",
    "Noted and queued. Want me to text you when it&rsquo;s finished? I can reach your phone from right here.",
    "Consider it handled. I&rsquo;ve spun the task off to the Coder agent — watch the Terminals tab to see it work.",
  ];
  const ROUTES = [
    { re: /call|phone|ring/i, text: "Done — I&rsquo;ll ring you the moment it finishes. ☎ Call scheduled against +1&nbsp;•••&nbsp;•••&nbsp;4821. You can pick up anywhere and just talk to me." },
    { re: /terminal|build|test|run|deploy/i, text: "Spinning up a fresh pane… ✓ started in terminal 2. The session stays alive even if you close the app — flip to the <b>Terminals</b> tab and click a pane to focus it." },
    { re: /voice|speak|talk|friday|jarvis/i, text: "You can talk to me hands-free — open the <b>Voice</b> tab and hit preview. Jarvis and Friday are both free local presets that never leave your machine." },
    { re: /what can you do|help|who are you|hi$|hello/i, text: "I&rsquo;m Jarvis — your workspace copilot. I run persistent terminals, coordinate agents, remember everything across sessions, and I can even <b>call your phone</b> when a job finishes." },
    { re: /memor|remember|context/i, text: "Everything in this workspace shares one living memory — chats, agents, tasks, calls. Close the app on Tuesday, pick the thread back up on Friday. I won&rsquo;t forget." },
    { re: /plugin|github|stripe|supabase/i, text: "There are <b>112 verified plugins</b> in the catalog — GitHub, Stripe, Supabase, browsers, calendars. One click and they snap into the workspace." },
  ];
  let genericIdx = 0;
  const pickReply = (q) => {
    for (const r of ROUTES) if (r.re.test(q)) return r.text;
    const t = GENERIC[genericIdx % GENERIC.length];
    genericIdx += 1;
    return t;
  };

  const scrollChat = () => { if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight; };

  const addUserMsg = (text) => {
    const el = document.createElement("div");
    el.className = "aw-msg aw-msg--user";
    el.textContent = text;
    chatScroll.appendChild(el);
    scrollChat();
  };

  let replying = false;
  const jarvisReply = async (q) => {
    if (replying) return;
    replying = true;

    const dots = document.createElement("div");
    dots.className = "aw-msg aw-msg--ai aw-msg--typing";
    dots.innerHTML = "<i></i><i></i><i></i>";
    chatScroll.appendChild(dots);
    scrollChat();
    await sleep(reducedMotion ? 150 : 800 + Math.random() * 500);
    dots.remove();

    const msg = document.createElement("div");
    msg.className = "aw-msg aw-msg--ai";
    const who = '<span class="aw-msg__who"><img src="assets/images/logo.png" width="16" height="16" alt="" /> Jarvis</span>';
    const reply = pickReply(q);
    msg.innerHTML = who;
    chatScroll.appendChild(msg);

    if (reducedMotion) {
      msg.innerHTML = who + reply;
      scrollChat();
    } else {
      /* stream the reply word by word (reply contains entities/tags,
         so split on spaces and rebuild — safe because the strings are ours) */
      const words = reply.split(" ");
      let built = "";
      for (let i = 0; i < words.length; i++) {
        built += (i ? " " : "") + words[i];
        msg.innerHTML = who + built + '<span class="t-caret"></span>';
        scrollChat();
        await sleep(34 + Math.random() * 50);
      }
      msg.innerHTML = who + built;
    }
    replying = false;
  };

  if (chatForm && chatInput && chatScroll) {
    chatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = chatInput.value.trim();
      if (!q || replying) return;
      chatInput.value = "";
      addUserMsg(q);
      jarvisReply(q);
    });
  }
  if (chatChips) {
    chatChips.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || replying) return;
      addUserMsg(b.textContent);
      jarvisReply(b.textContent);
    });
  }

  /* ========================= TERMINALS ============================= */
  const SCRIPTS = {
    opencode: [
      ["t-dim", "◆ opencode · mimo-v2.5 — session restored"],
      ["t-prompt", "> review the new budget guard"],
      ["t-dim", "  reading supabase/functions/_shared/budget.ts…"],
      ["t-accent", "  ◆ thought · 1.4s"],
      ["t-ok", "  ✓ reservation is atomic — no race found"],
      ["t-dim", "  17.3K (9%) · ctrl+p commands"],
    ],
    agent: [
      ["t-prompt", "PS C:\\projects> jarvis \u201Cfix the flaky test\u201D"],
      ["t-accent", "◆ Coder — planning…"],
      ["t-dim", "  ├─ patching terminalEscape.ts"],
      ["t-dim", "  ├─ rerunning suite…"],
      ["t-ok", "  ✓ 364 / 364 tests passing"],
      ["t-voice", "◉ \u201CDone — want me to commit it?\u201D"],
    ],
    build: [
      ["t-prompt", "$ pnpm build"],
      ["t-dim", "vite v5.4 building for production…"],
      ["t-dim", "transforming · 1842 modules"],
      ["t-ok", "✓ built in 12.4s"],
      ["t-dim", "dist/ ready — 1.9 MB gzipped"],
      ["t-ok", "● session persisted — safe to close"],
    ],
    deploy: [
      ["t-prompt", "$ git push origin main"],
      ["t-dim", "Enumerating objects: 38, done."],
      ["t-ok", "✓ pushed — pages deploy queued"],
      ["t-dim", "waiting for CDN…"],
      ["t-ok", "● live at vibespaceos.com"],
      ["t-voice", "◉ Jarvis: \u201CShall I call you? It\u2019s shipped.\u201D"],
    ],
  };

  const runPane = async (body, lines, offset) => {
    await sleep(offset);
    for (;;) {
      body.innerHTML = "";
      for (const [cls, text] of lines) {
        const el = document.createElement("span");
        el.className = "t-line " + cls;
        if (reducedMotion) {
          el.textContent = text;
          body.appendChild(el);
        } else {
          body.appendChild(el);
          for (let i = 0; i <= text.length; i++) {
            el.textContent = text.slice(0, i);
            await sleep(10 + Math.random() * 16);
          }
        }
        await sleep(reducedMotion ? 60 : 420 + Math.random() * 380);
      }
      await sleep(2600);
    }
  };

  const termGrid = document.getElementById("termGrid");
  if (termGrid) {
    /* start the typing loops only when the demo is near the viewport */
    const start = () => {
      termGrid.querySelectorAll(".aw-pane__body").forEach((body, i) => {
        runPane(body, SCRIPTS[body.dataset.script] || SCRIPTS.build, i * 900);
      });
    };
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          start();
        }
      }, { threshold: 0.1 });
      io.observe(termGrid);
    } else {
      start();
    }

    /* click a pane → fullscreen focus inside the app window */
    termGrid.addEventListener("click", (e) => {
      const pane = e.target.closest(".aw-pane");
      if (!pane) return;
      const wasFull = pane.classList.contains("is-full");
      termGrid.querySelectorAll(".aw-pane").forEach((p) => p.classList.remove("is-full"));
      termGrid.classList.toggle("has-full", !wasFull);
      if (!wasFull) pane.classList.add("is-full");
    });
  }

  /* =========================== VOICE =============================== */
  const blip = (base) => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      window.__awAC = window.__awAC || new Ctx();
      const ctx = window.__awAC;
      const t = ctx.currentTime;
      [1, 1.34, 1.5, 1.2].forEach((mult, i) => {
        const off = i * 0.11;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = base * mult;
        g.gain.setValueAtTime(0.0001, t + off);
        g.gain.exponentialRampToValueAtTime(0.05, t + off + 0.025);
        g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.18);
        o.connect(g).connect(ctx.destination);
        o.start(t + off);
        o.stop(t + off + 0.22);
      });
    } catch { /* audio is a garnish — never break the page */ }
  };

  aw.querySelectorAll(".aw-voice__card").forEach((card) => {
    card.addEventListener("click", () => {
      aw.querySelectorAll(".aw-voice__card").forEach((c) => c.classList.toggle("is-on", c === card));
    });
  });

  aw.querySelectorAll(".aw-voice__prev").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const card = btn.closest(".aw-voice__card");
      aw.querySelectorAll(".aw-voice__card").forEach((c) => c.classList.toggle("is-on", c === card));
      blip(Number(btn.dataset.base) || 200);
      card.classList.add("is-speaking");
      setTimeout(() => card.classList.remove("is-speaking"), 1700);
    });
  });

  const handsFree = document.getElementById("handsFree");
  if (handsFree) {
    const flip = () => {
      const on = handsFree.classList.toggle("is-on");
      handsFree.setAttribute("aria-checked", String(on));
    };
    handsFree.addEventListener("click", flip);
    handsFree.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
    });
  }

  const pauseRange = document.getElementById("pauseRange");
  const pauseOut = document.getElementById("pauseOut");
  if (pauseRange && pauseOut) {
    pauseRange.addEventListener("input", () => {
      pauseOut.textContent = Number(pauseRange.value).toFixed(1);
    });
  }
})();
