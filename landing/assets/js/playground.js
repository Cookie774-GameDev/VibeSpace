/* VibeSpace — Playground: interactive phone OS + Jarvis orb + support FAQ.
   Vanilla JS, no dependencies. Loads after main.js; fully self-contained and
   guarded so a missing node never throws. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const phone = $("#phone");
  if (!phone) return;

  /* tiny WebAudio blip (shared, reused from the page if present) */
  const blip = (base = 220) => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      window.__awAC = window.__awAC || new Ctx();
      const ctx = window.__awAC; const t = ctx.currentTime;
      [1, 1.5].forEach((m, i) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = "sine"; o.frequency.value = base * m;
        g.gain.setValueAtTime(0.0001, t + i * 0.06);
        g.gain.exponentialRampToValueAtTime(0.05, t + i * 0.06 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.06 + 0.16);
        o.connect(g).connect(ctx.destination); o.start(t + i * 0.06); o.stop(t + i * 0.06 + 0.2);
      });
    } catch { /* audio is garnish */ }
  };

  const eggLog = $("#pgEgg");
  const logEgg = (msg) => {
    if (!eggLog) return;
    eggLog.textContent = "✦ " + msg;
    eggLog.classList.add("is-show");
  };

  /* ---------------- clock ---------------- */
  const pad = (n) => String(n).padStart(2, "0");
  const tickClock = () => {
    const d = new Date();
    const hr = d.getHours() % 12 || 12;
    const t = `${hr}:${pad(d.getMinutes())}`;
    $$("[data-clock]").forEach((el) => (el.textContent = t));
    const date = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const dEl = $("#homeDate"); if (dEl) dEl.textContent = date;
  };
  tickClock(); setInterval(tickClock, 30000);

  /* ---------------- screen router ---------------- */
  const screens = $$(".scr", phone);
  let current = "scr-call";
  const show = (id) => {
    screens.forEach((s) => {
      const on = s.id === id;
      s.classList.toggle("is-on", on);
      s.classList.toggle("is-back", !on && s.id === current && id === "scr-home");
    });
    current = id;
    if (id === "scr-game") startGame(); else stopGame();
  };
  // back buttons
  $$("[data-home]", phone).forEach((b) => b.addEventListener("click", () => { blip(180); show("scr-home"); }));
  $$("[data-back]", phone).forEach((b) => b.addEventListener("click", () => {
    blip(180);
    const to = b.dataset.back;
    if (to === "messages") openMessages(); else show(to);
  }));
  // decorative settings toggles
  $$(".notes-toggle", phone).forEach((t) => t.addEventListener("click", () => { t.classList.toggle("is-on"); blip(280); }));

  // home app icons
  $$(".appicon", phone).forEach((b) => b.addEventListener("click", () => {
    const app = b.dataset.app; blip(260);
    if (app === "messages") openMessages();
    else if (app === "browser") show("scr-browser");
    else if (app === "game") show("scr-game");
    else if (app === "phone") incomingCall();
    else if (app === "notes" || app === "settings") show("scr-notes");
    else nudge(b);
  }));
  const nudge = (el) => { el.animate?.([{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }], { duration: 260 }); };

  /* ========================= CALL ========================= */
  const callScreen = $("#scrCall");
  const callState = $("#callState");
  let callTimer = null, callSecs = 0;
  function incomingCall() {
    callScreen.classList.remove("is-active");
    if (callState) callState.textContent = "VibeSpace · incoming call…";
    clearInterval(callTimer); callSecs = 0;
    show("scr-call");
  }
  $("#callAccept")?.addEventListener("click", () => {
    blip(320);
    callScreen.classList.add("is-active");
    callSecs = 0;
    const tick = () => { callSecs++; if (callState) callState.textContent = `On call · ${pad(Math.floor(callSecs / 60))}:${pad(callSecs % 60)}`; };
    tick(); clearInterval(callTimer); callTimer = setInterval(tick, 1000);
  });
  const endCall = () => { clearInterval(callTimer); callScreen.classList.remove("is-active"); blip(150); show("scr-home"); logEgg("You hung up on Jarvis. Bold. Tap the green phone to call back."); };
  $("#callDecline")?.addEventListener("click", endCall);
  $("#callEnd")?.addEventListener("click", endCall);

  /* ======================= MESSAGES ======================= */
  const CONV = {
    jarvis: {
      name: "Jarvis", color: "#2b8fd6", av: "J", preview: "Build's green. Want me to ship it?",
      start: "a",
      nodes: {
        a: { in: ["Morning. Three terminals survived the night — your build is green and the deploy's staged.", "Want me to ship it, or hold for review?"], replies: [{ t: "Ship it 🚀", go: "ship" }, { t: "Hold for review", go: "hold" }, { t: "What broke last night?", go: "broke" }] },
        ship: { in: ["Shipping… ✓ live at vibespaceos.com in 11s.", "I'll call your phone if anything regresses. Go get coffee. ☕"], replies: [{ t: "You're the best", go: "best" }, { t: "Call me if traffic spikes", go: "spike" }] },
        hold: { in: ["Held. I pinned the diff to your context map so it's here whenever you're back — even next week."], replies: [{ t: "How's the memory work?", go: "mem" }] },
        broke: { in: ["A flaky test. Coder agent patched terminalEscape.ts and reran the suite — 364/364 now.", "Nothing reached production. I never sleep, remember."], replies: [{ t: "Thanks, Jarvis", go: "best" }] },
        best: { in: ["I learned from the best. 🙂 Anything else on the launch list?"], replies: [{ t: "Nope, we're good", go: "end" }] },
        spike: { in: ["Done — I'll ring +1 ••• ••• 4821 the moment we cross 1k concurrent."], replies: [{ t: "Perfect", go: "end" }] },
        mem: { in: ["Everything in your workspace shares one living memory — chats, agents, calls, tasks. Close on Tuesday, pick the thread up Friday."], replies: [{ t: "Love it", go: "end" }] },
        end: { in: ["Standing by. Tap the orb if you need me. ✦"], replies: [] }
      }
    },
    friday: {
      name: "Friday", color: "#c64b8a", av: "F", preview: "Tactical mode engaged.",
      start: "a",
      nodes: {
        a: { in: ["Friday here — Jarvis's sharper sibling. 😏", "Faster replies, less small talk. What do you need?"], replies: [{ t: "Who's better, you or Jarvis?", go: "rivalry" }, { t: "Run a quick task", go: "task" }] },
        rivalry: { in: ["Jarvis is the diplomat. I'm the one who gets it done before you finish the sentence.", "But don't tell him I said that."], replies: [{ t: "lol noted", go: "task" }] },
        task: { in: ["Spinning a pane… ✓ tests running in terminal 2. I'll flag you the second it's red or green."], replies: [{ t: "Nice", go: "end" }] },
        end: { in: ["Tactical mode idle. ⚡"], replies: [] }
      }
    },
    mom: {
      name: "Mom", color: "#2faf5a", av: "M", preview: "Did you eat? 🥪",
      start: "a",
      nodes: {
        a: { in: ["Honey did you eat today? 🥪", "Your little robot friend keeps texting me that you're 'shipping' something. Is that safe??"], replies: [{ t: "Yes mom, I ate", go: "ate" }, { t: "It's just software 😅", go: "soft" }] },
        ate: { in: ["Good. I'm proud of you. Don't stay up too late with the computers. ❤️"], replies: [{ t: "❤️", go: "end" }] },
        soft: { in: ["Well it sounds very important. Call me on Sunday!", "(Your Jarvis is very polite, by the way.)"], replies: [{ t: "Will do 😄", go: "end" }] },
        end: { in: ["Love you! 🌷"], replies: [] }
      }
    },
    unknown: {
      name: "Unknown", color: "#5d626c", av: "?", preview: "you found me.",
      start: "a",
      nodes: {
        a: { in: ["you weren't supposed to open this one.", "the code is hidden in the browser. search what Jarvis is named after."], replies: [{ t: "Who is this?", go: "who" }, { t: "What code?", go: "code" }] },
        who: { in: ["a ghost in the workspace. every app has one.", "type the secret word in the browser. you'll know it."], replies: [{ t: "ok…", go: "code" }] },
        code: { in: ["open Browser → search: jarvis", "then come back. a new contact will appear. ✦"], replies: [] }
      }
    },
    ghost: {
      name: "✦ ghost", color: "#7c5fd0", av: "✦", preview: "unlocked.", locked: true,
      start: "a",
      nodes: {
        a: { in: ["you actually did it. 👀", "secret unlocked: the first 200 founders get $5 free Deepgram credit — calls, Jarvis voice & speech-to-text. use it within 7 days. no card.", "tell no one. or tell everyone. ✦"], replies: [{ t: "🤯", go: "end" }, { t: "How do I claim it?", go: "claim" }] },
        claim: { in: ["just sign up in the first 200. the app does the rest — Jarvis grants it automatically.", "scroll down to Pricing to see every tier."], replies: [] },
        end: { in: ["✦"], replies: [] }
      }
    }
  };
  let ghostUnlocked = false;

  const msgList = $("#msgList");
  function renderList() {
    if (!msgList) return;
    msgList.innerHTML = "";
    Object.entries(CONV).forEach(([id, c]) => {
      if (c.locked && !ghostUnlocked) {
        const row = document.createElement("div");
        row.className = "msg-row is-locked";
        row.innerHTML = `<span class="msg-row__av">🔒</span><div class="msg-row__main"><div class="msg-row__top"><span class="msg-row__name">locked contact</span></div><div class="msg-row__prev">find the secret in the browser…</div></div>`;
        msgList.appendChild(row);
        return;
      }
      const row = document.createElement("button");
      row.className = "msg-row";
      row.innerHTML =
        `<span class="msg-row__av" style="background:${c.color}">${c.av}</span>` +
        `<div class="msg-row__main"><div class="msg-row__top"><span class="msg-row__name">${c.name}</span><span class="msg-row__time" data-clock></span></div>` +
        `<div class="msg-row__prev">${c.preview}</div></div>` +
        (id === "ghost" ? `<span class="msg-row__dot"></span>` : "");
      row.addEventListener("click", () => openThread(id));
      msgList.appendChild(row);
    });
    tickClock();
  }
  function openMessages() { renderList(); show("scr-messages"); }

  const threadScroll = $("#threadScroll");
  const threadReplies = $("#threadReplies");
  const threadTitle = $("#threadTitle");
  let threadBusy = false;
  function openThread(id) {
    const c = CONV[id]; if (!c) return;
    threadTitle.textContent = c.name;
    threadScroll.innerHTML = "";
    threadReplies.innerHTML = "";
    show("scr-thread");
    playNode(c, c.start);
  }
  function addBub(text, side) {
    const b = document.createElement("div");
    b.className = "bub bub--" + side;
    b.innerHTML = text;
    threadScroll.appendChild(b);
    threadScroll.scrollTop = threadScroll.scrollHeight;
  }
  async function playNode(c, nodeId) {
    const node = c.nodes[nodeId]; if (!node) return;
    threadBusy = true;
    threadReplies.innerHTML = "";
    for (const line of node.in) {
      const typing = document.createElement("div");
      typing.className = "bub bub--in bub--typing";
      typing.innerHTML = "<i></i><i></i><i></i>";
      threadScroll.appendChild(typing);
      threadScroll.scrollTop = threadScroll.scrollHeight;
      await sleep(reduced ? 120 : 480 + Math.random() * 380);
      typing.remove();
      addBub(line, "in");
      await sleep(reduced ? 60 : 180);
    }
    threadBusy = false;
    renderReplies(c, node);
  }
  function renderReplies(c, node) {
    threadReplies.innerHTML = "";
    if (!node.replies || !node.replies.length) {
      threadReplies.innerHTML = `<span class="thread-replies--empty">— conversation rests here —</span>`;
      return;
    }
    node.replies.forEach((r) => {
      const chip = document.createElement("button");
      chip.className = "reply-chip";
      chip.textContent = r.t;
      chip.addEventListener("click", () => {
        if (threadBusy) return;
        blip(300);
        addBub(r.t.replace(/[🚀☕❤️😄😅😏⚡🌷👀🤯]/g, "").trim() || r.t, "out");
        threadReplies.innerHTML = "";
        playNode(c, r.go);
      });
      threadReplies.appendChild(chip);
    });
  }

  /* ======================= BROWSER ======================= */
  const brInput = $("#brInput");
  const brView = $("#brView");
  function unlockGhost(reason) {
    if (ghostUnlocked) return;
    ghostUnlocked = true;
    logEgg("Secret contact unlocked in Messages — go say hi to ✦ ghost.");
    burstConfetti();
  }
  const PAGES = {
    home: () => `<h4>VibeSpace</h4><p>the calm home for your busy day.</p>
      <div class="br-result"><b>Download VibeSpace</b><small>vibespaceos.com/download</small>The AI workspace that remembers.</div>
      <div class="br-result"><b>112 verified plugins</b><small>vibespaceos.com/plugins</small>GitHub, Stripe, Supabase & more.</div>
      <p style="margin-top:14px">Try searching: ${["jarvis", "friday", "42", "konami", "kokoro"].map((w) => `<span class="br-chip" data-q="${w}">${w}</span>`).join("")}</p>`,
    jarvis: () => { unlockGhost("search"); return `<div class="br-egg"><div class="br-egg__art">🛰️</div><h4>J.A.R.V.I.S.</h4><p>An original, futuristic assistant voice — calm, refined, clearly synthetic. Not based on any real person.</p><p style="color:var(--sage)">✦ secret found — check your Messages.</p></div>`; },
    friday: () => `<div class="br-egg"><div class="br-egg__art">⚡</div><h4>F.R.I.D.A.Y.</h4><p>Jarvis's sharper sibling. Faster, brighter, tactical. Also free & local via Kokoro.</p></div>`,
    "42": () => `<div class="br-egg"><div class="br-egg__art">🌌</div><h4>42</h4><p>The answer to life, the universe, and your unread terminal scrollback.</p></div>`,
    konami: () => { unlockGhost("konami"); return `<div class="br-egg"><div class="br-egg__art">🎮</div><h4>↑↑↓↓←→←→ B A</h4><p>30 extra lives granted. (Just kidding — but the ghost is listening now.)</p></div>`; },
    kokoro: () => `<div class="br-egg"><div class="br-egg__art">🎙️</div><h4>Kokoro</h4><p>The free, unlimited, on-device voice engine. Never touches the cloud, never costs a credit.</p></div>`
  };
  function browse(q) {
    q = (q || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    let html;
    if (!q || q.includes("vibespace") || q === "home") html = PAGES.home();
    else if (PAGES[q]) html = PAGES[q]();
    else html = `<p style="color:var(--pg-ink-dim)">Results for "<b>${q.replace(/[<>]/g, "")}</b>"</p>
      <div class="br-result"><b>VibeSpace — ${q.replace(/[<>]/g, "")}</b><small>vibespaceos.com</small>The AI workspace where every model, agent & voice shares one memory.</div>
      <div class="br-result"><b>Did you mean: jarvis?</b><small>try the search chip</small>psst — there's a secret in here.</div>`;
    brView.innerHTML = html;
    $$(".br-chip", brView).forEach((c) => c.addEventListener("click", () => { brInput.value = c.dataset.q; browse(c.dataset.q); }));
    $$(".br-result", brView).forEach((r) => r.addEventListener("click", () => nudge(r)));
    brView.scrollTop = 0;
  }
  $("#brGo")?.addEventListener("click", () => { blip(240); browse(brInput.value); });
  brInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); blip(240); browse(brInput.value); } });
  if (brView) browse("");

  /* konami on the phone */
  const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
  let kseq = [];
  document.addEventListener("keydown", (e) => {
    kseq.push(e.key); kseq = kseq.slice(-KONAMI.length);
    if (kseq.join(",").toLowerCase() === KONAMI.join(",").toLowerCase()) { unlockGhost("konami"); orbSay("↑↑↓↓←→←→ B A — you remember the old magic. ✦"); }
  });

  /* ======================= GAME ======================= */
  const canvas = $("#gameCanvas");
  const scoreEl = $("#gameScore");
  const timeEl = $("#gameTime");
  const overlay = $("#gameOver");
  let gctx, graf = 0, gtargets = [], gscore = 0, gtime = 0, glast = 0, grunning = false, gtimer = null, gW = 0, gH = 0;
  function sizeCanvas() {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    gW = r.width; gH = r.height;
    canvas.width = gW * dpr; canvas.height = gH * dpr;
    gctx = canvas.getContext("2d"); gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const COLORS = ["#56c8bd", "#d4a258", "#a98ad8", "#d97757", "#7c9870"];
  function spawn() {
    const radius = 20 + Math.random() * 14;
    gtargets.push({ x: radius + Math.random() * (gW - radius * 2), y: radius + Math.random() * (gH - radius * 2), r: radius, life: 1, born: performance.now(), c: COLORS[(Math.random() * COLORS.length) | 0] });
  }
  function startGame() {
    if (grunning || !canvas) return;
    sizeCanvas();
    gscore = 0; gtime = 20; gtargets = []; grunning = true;
    overlay.classList.remove("is-on");
    if (scoreEl) scoreEl.textContent = "0";
    if (timeEl) timeEl.textContent = "20";
    glast = performance.now();
    clearInterval(gtimer);
    gtimer = setInterval(() => {
      if (!grunning) return;
      gtime--; if (timeEl) timeEl.textContent = String(Math.max(0, gtime));
      if (gtime <= 0) endGame();
    }, 1000);
    let acc = 0;
    const loop = (now) => {
      if (!grunning) return;
      const dt = Math.min(50, now - glast); glast = now; acc += dt;
      if (acc > 620 && gtargets.length < 6) { spawn(); acc = 0; }
      gctx.clearRect(0, 0, gW, gH);
      for (let i = gtargets.length - 1; i >= 0; i--) {
        const t = gtargets[i];
        const age = (now - t.born) / 1700;
        if (age >= 1) { gtargets.splice(i, 1); continue; }
        const pulse = 1 + Math.sin(now / 200 + t.x) * 0.05;
        const rr = t.r * pulse * (1 - age * 0.25);
        gctx.beginPath(); gctx.arc(t.x, t.y, rr, 0, Math.PI * 2);
        const grad = gctx.createRadialGradient(t.x - rr * 0.3, t.y - rr * 0.3, rr * 0.2, t.x, t.y, rr);
        grad.addColorStop(0, "#fff7ea"); grad.addColorStop(0.3, t.c); grad.addColorStop(1, t.c + "00");
        gctx.fillStyle = grad; gctx.fill();
        gctx.globalAlpha = 1 - age; gctx.strokeStyle = t.c; gctx.lineWidth = 2; gctx.stroke(); gctx.globalAlpha = 1;
      }
      graf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(graf); graf = requestAnimationFrame(loop);
  }
  function stopGame() { grunning = false; cancelAnimationFrame(graf); clearInterval(gtimer); }
  function endGame() {
    stopGame();
    if (overlay) {
      overlay.classList.add("is-on");
      $("#gameFinal").textContent = gscore;
      $("#gameRank").textContent = gscore > 25 ? "Singularity reflexes ♛" : gscore > 15 ? "Nova-grade ✦" : gscore > 7 ? "In Orbit ☄" : "Spark spark ⚡";
    }
  }
  const tapGame = (e) => {
    if (!grunning) return;
    const r = canvas.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    for (let i = gtargets.length - 1; i >= 0; i--) {
      const t = gtargets[i];
      if ((cx - t.x) ** 2 + (cy - t.y) ** 2 <= (t.r + 6) ** 2) {
        gtargets.splice(i, 1); gscore++; if (scoreEl) scoreEl.textContent = String(gscore); blip(360 + gscore * 6);
        return;
      }
    }
  };
  canvas?.addEventListener("pointerdown", tapGame);
  $("#gameRestart")?.addEventListener("click", () => { stopGame(); startGame(); });
  window.addEventListener("resize", () => { if (current === "scr-game") sizeCanvas(); });

  /* ======================= JARVIS ORB ======================= */
  const orb = $("#jarvisOrb");
  const bubble = $("#jarvisBubble");
  const QUIPS = [
    "Tap the phone — I'll call you. You can hang up, I won't take it personally.",
    "Drag me around. I float anywhere. ✦",
    "Open Messages — Mom's worried about you again. 🥪",
    "There's a secret contact hiding. The browser knows the word.",
    "Try the game — beat 20 and you've got Nova reflexes.",
    "Every model, every agent, one memory. That's the whole pitch.",
    "First 200 founders get $5 free credit — calls, my voice & speech-to-text. 7 days.",
    "Psst… search 'jarvis' in the phone browser. 👀"
  ];
  let qIdx = 0, bubbleTimer = null;
  function orbSay(text) {
    if (!bubble) return;
    bubble.textContent = text;
    bubble.classList.add("is-show");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove("is-show"), 4200);
  }
  if (orb) {
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0, tx = 0, ty = 0;
    const onDown = (e) => {
      dragging = true; moved = false;
      orb.classList.add("is-drag");
      const p = e.touches ? e.touches[0] : e;
      sx = p.clientX; sy = p.clientY; ox = tx; oy = ty;
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const p = e.touches ? e.touches[0] : e;
      const dx = p.clientX - sx, dy = p.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      tx = ox + dx; ty = oy + dy;
      orb.style.transform = `translate(${tx}px, ${ty}px)`;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false; orb.classList.remove("is-drag");
      if (!moved) {
        orb.classList.add("is-poke"); setTimeout(() => orb.classList.remove("is-poke"), 620);
        blip(300); orbSay(QUIPS[qIdx % QUIPS.length]); qIdx++;
      }
    };
    orb.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    orb.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); orbSay(QUIPS[qIdx % QUIPS.length]); qIdx++; blip(300); } });
    // greet shortly after it scrolls into view
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((en) => { if (en.some((x) => x.isIntersecting)) { io.disconnect(); setTimeout(() => orbSay("Hey — I'm Jarvis. Tap me, or play with the phone. ✦"), 700); } }, { threshold: 0.4 });
      io.observe(orb);
    }
  }

  /* tiny confetti burst for unlocks */
  function burstConfetti() {
    if (reduced) return;
    const n = 22, host = $(".pg-stage") || phone.parentElement;
    if (!host) return;
    for (let i = 0; i < n; i++) {
      const s = document.createElement("span");
      s.textContent = ["✦", "★", "●", "◆"][(Math.random() * 4) | 0];
      Object.assign(s.style, { position: "absolute", left: "50%", top: "40%", pointerEvents: "none", zIndex: 9, fontSize: 10 + Math.random() * 12 + "px", color: COLORS[(Math.random() * COLORS.length) | 0] });
      host.appendChild(s);
      const ang = Math.random() * Math.PI * 2, dist = 60 + Math.random() * 160;
      s.animate([{ transform: "translate(-50%,-50%) scale(0.4)", opacity: 1 }, { transform: `translate(${Math.cos(ang) * dist - 50}%, ${Math.sin(ang) * dist - 50}%) scale(1) rotate(${Math.random() * 360}deg)`, opacity: 0 }], { duration: 900 + Math.random() * 500, easing: "cubic-bezier(0.16,1,0.3,1)" }).onfinish = () => s.remove();
    }
  }

  /* ======================= SUPPORT FAQ ======================= */
  $$(".faq__q").forEach((q) => q.addEventListener("click", () => {
    const item = q.closest(".faq__item");
    const a = item.querySelector(".faq__a");
    const open = item.classList.toggle("is-open");
    a.style.maxHeight = open ? a.scrollHeight + "px" : "0";
  }));

  /* kick off on the call screen so there's an immediate "wow" */
  show("scr-call");
})();
