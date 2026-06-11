/* ============================================================================
   VibeSpace — vibespaceos.com landing interactions
   Plain vanilla JS, no frameworks. Loaded with `defer`.
   Modules: nav · scroll progress · cursor glow · scroll-reveal (staggered)
            · active-link · orb parallax · card tilt+spotlight · count-up
            · magnetic buttons · video switcher · chat demo · contact form
   ========================================================================== */
(function () {
  'use strict';

  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer    = window.matchMedia('(pointer:fine)').matches;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  /* ----------------------------- Footer year ---------------------------- */
  const yearEl = $('#year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ------------------------------- Toast --------------------------------- */
  const toastEl = $('#toast');
  let toastTimer;
  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('is-visible');
      setTimeout(() => { toastEl.hidden = true; }, 320);
    }, 2600);
  }

  /* --------------------------- Navbar behavior --------------------------- */
  const nav       = $('.nav');
  const navToggle = $('#navToggle');
  const navLinks  = $('#navLinks');

  function closeMenu() {
    if (!navLinks || !navToggle) return;
    navLinks.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', 'Open menu');
  }
  function openMenu() {
    if (!navLinks || !navToggle) return;
    navLinks.classList.add('is-open');
    navToggle.setAttribute('aria-expanded', 'true');
    navToggle.setAttribute('aria-label', 'Close menu');
  }
  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      navLinks.classList.contains('is-open') ? closeMenu() : openMenu();
    });
    $$('#navLinks a').forEach((a) => a.addEventListener('click', closeMenu));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    document.addEventListener('click', (e) => {
      if (!navLinks.classList.contains('is-open')) return;
      if (!navLinks.contains(e.target) && !navToggle.contains(e.target)) closeMenu();
    });
  }

  /* --------------------- Scroll progress + nav state + parallax ---------- */
  const progressBar = $('#scrollProgress');
  const orbs = $$('.orb[data-parallax]');

  let ticking = false;
  function onScrollFrame() {
    const y = window.scrollY || window.pageYOffset;

    // sticky nav shade
    if (nav) nav.classList.toggle('is-scrolled', y > 12);

    // top progress bar
    if (progressBar) {
      const docH = document.documentElement.scrollHeight - window.innerHeight;
      const p = docH > 0 ? clamp(y / docH, 0, 1) : 0;
      progressBar.style.transform = `scaleX(${p})`;
    }

    // subtle orb parallax
    if (!prefersReduced) {
      for (const orb of orbs) {
        const factor = parseFloat(orb.getAttribute('data-parallax')) || 0.05;
        orb.style.transform = `translateY(${y * factor}px)`;
      }
    }
    ticking = false;
  }
  function requestScroll() {
    if (!ticking) { window.requestAnimationFrame(onScrollFrame); ticking = true; }
  }
  onScrollFrame();
  window.addEventListener('scroll', requestScroll, { passive: true });
  window.addEventListener('resize', requestScroll, { passive: true });

  /* ---------------------- Cursor-following spotlight --------------------- */
  const cursorGlow = $('#cursorGlow');
  if (cursorGlow && finePointer && !prefersReduced) {
    let gx = window.innerWidth / 2, gy = window.innerHeight / 2;  // target
    let cx = gx, cy = gy;                                         // current (eased)
    let raf = null;
    const render = () => {
      cx += (gx - cx) * 0.16;
      cy += (gy - cy) * 0.16;
      cursorGlow.style.transform = `translate(${cx}px, ${cy}px)`;
      if (Math.abs(gx - cx) > 0.5 || Math.abs(gy - cy) > 0.5) {
        raf = requestAnimationFrame(render);
      } else { raf = null; }
    };
    window.addEventListener('mousemove', (e) => {
      gx = e.clientX; gy = e.clientY;
      cursorGlow.classList.add('is-active');
      if (!raf) raf = requestAnimationFrame(render);
    }, { passive: true });
    document.addEventListener('mouseleave', () => cursorGlow.classList.remove('is-active'));
  }

  /* ------------------- Scroll-reveal (with stagger groups) --------------- */
  const revealEls = $$('.reveal');
  // Pre-compute a stagger delay for children of any `.stagger` container.
  $$('.stagger').forEach((group) => {
    $$('.reveal', group).forEach((child, i) => {
      child.style.transitionDelay = `${Math.min(i * 90, 450)}ms`;
    });
  });

  if (prefersReduced || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('is-visible'));
  } else {
    const revealObserver = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    revealEls.forEach((el) => revealObserver.observe(el));
  }

  /* ------------------------- Active nav highlight ------------------------ */
  const sectionIds = ['home', 'features', 'how', 'connect', 'demo', 'chat', 'about', 'voices', 'download', 'faq', 'contact'];
  const sections = sectionIds.map((id) => document.getElementById(id)).filter(Boolean);
  const linkFor = (id) => $(`#navLinks a[href="#${id}"]`);

  if ('IntersectionObserver' in window && sections.length) {
    const navObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          $$('#navLinks a').forEach((a) => a.classList.remove('is-active'));
          const link = linkFor(entry.target.id);
          if (link) link.classList.add('is-active');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
    sections.forEach((s) => navObserver.observe(s));
  }

  /* --------------------- Card tilt + mouse spotlight --------------------- */
  if (finePointer && !prefersReduced) {
    $$('[data-tilt]').forEach((card) => {
      card.addEventListener('mousemove', (e) => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        // spotlight position (CSS vars consumed by ::before)
        card.style.setProperty('--mx', `${px * 100}%`);
        card.style.setProperty('--my', `${py * 100}%`);
        // gentle tilt
        const rx = (0.5 - py) * 6;
        const ry = (px - 0.5) * 6;
        card.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-4px)`;
      });
      card.addEventListener('mouseleave', () => { card.style.transform = ''; });
    });
  }

  /* ----------------------- Magnetic primary buttons ---------------------- */
  if (finePointer && !prefersReduced) {
    $$('.magnetic').forEach((btn) => {
      btn.addEventListener('mousemove', (e) => {
        const r = btn.getBoundingClientRect();
        const mx = e.clientX - r.left - r.width / 2;
        const my = e.clientY - r.top - r.height / 2;
        btn.style.transform = `translate(${mx * 0.18}px, ${my * 0.28}px)`;
      });
      btn.addEventListener('mouseleave', () => { btn.style.transform = ''; });
    });
  }

  /* --------------------------- Count-up stats ---------------------------- */
  function countUp(el) {
    const target = parseFloat(el.getAttribute('data-count')) || 0;
    const suffix = el.getAttribute('data-suffix') || '';
    if (prefersReduced) { el.textContent = target + suffix; return; }
    const dur = 1100;
    const start = performance.now();
    const step = (now) => {
      const t = clamp((now - start) / dur, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      el.textContent = Math.round(target * eased) + suffix;
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = target + suffix;
    };
    requestAnimationFrame(step);
  }
  const counters = $$('[data-count]');
  if (counters.length) {
    if (!('IntersectionObserver' in window)) {
      counters.forEach(countUp);
    } else {
      const countObserver = new IntersectionObserver((entries, obs) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) { countUp(entry.target); obs.unobserve(entry.target); }
        });
      }, { threshold: 0.6 });
      counters.forEach((c) => countObserver.observe(c));
    }
  }

  /* --------------------------- Video switcher ---------------------------- */
  const featuredVideo  = $('#featuredVideo');
  const featuredSource = $('#featuredSource');
  const videoCaption   = $('#videoCaption');
  const videoFallback  = $('#videoFallback');
  const thumbs         = $$('#videoList .video__thumb');

  function showFallback(missingSrc) {
    if (!videoFallback || !featuredVideo) return;
    featuredVideo.style.display = 'none';
    videoFallback.hidden = false;
    const codeEl = $('code', videoFallback);
    if (codeEl && missingSrc) codeEl.textContent = missingSrc;
  }
  function hideFallback() {
    if (!videoFallback || !featuredVideo) return;
    featuredVideo.style.display = '';
    videoFallback.hidden = true;
  }
  if (featuredVideo) {
    featuredVideo.addEventListener('error', () => {
      showFallback(featuredSource ? featuredSource.getAttribute('src') : '');
    }, true);
    if (featuredSource) {
      featuredSource.addEventListener('error', () => showFallback(featuredSource.getAttribute('src')));
    }
  }
  function switchVideo(thumb) {
    if (!featuredVideo || !featuredSource) return;
    const src   = thumb.getAttribute('data-src');
    const title = thumb.getAttribute('data-title') || 'VibeSpace demo';
    thumbs.forEach((t) => t.classList.remove('is-active'));
    thumb.classList.add('is-active');
    hideFallback();
    featuredSource.setAttribute('src', src);
    featuredVideo.load();
    if (videoCaption) videoCaption.textContent = title.replace(/&amp;/g, '&');
    featuredVideo.play().catch(() => { /* missing file / autoplay policy: no-op */ });
  }
  thumbs.forEach((thumb) => thumb.addEventListener('click', () => switchVideo(thumb)));

  /* --------------------- Interactive VibeSpace chat ---------------------- */
  const chatLog     = $('#chatLog');
  const chatForm    = $('#chatForm');
  const chatField   = $('#chatField');
  const suggestWrap = $('#chatSuggest');

  const SCRIPTED = {
    'call me at 3:00 am':
      "I can schedule a call reminder, but I'll make sure it's intentional before waking you up at 3:00 AM.",
    'help me launch my app':
      "I can help turn your app idea into a launch checklist with coding, design, payments, and deployment steps.",
    'show my local ai models':
      "Local model support lets you connect compatible local providers for private, offline-friendly workflows.",
    'message me a reminder':
      "Messaging can be used for reminders, updates, and assistant-triggered notifications.",
    'explain vibespace':
      "VibeSpace is a cozy desktop app that keeps chat, calls, messages, your tools, and the busywork together in one calm place.",
  };

  function keywordReply(text) {
    const t = text.toLowerCase();
    if (/(call|phone|ring|wake)/.test(t))
      return "I can set up call reminders and voice check-ins — and I'll confirm the timing so a 3:00 AM call is always on purpose.";
    if (/(launch|ship|app|build|startup|business)/.test(t))
      return "Tell me about your project and I'll draft a launch checklist covering build, design, payments, and deployment.";
    if (/(local|ollama|offline|private|model)/.test(t))
      return "Local model support lets you connect compatible providers like Ollama for private, offline-friendly workflows.";
    if (/(message|remind|notify|notification|text)/.test(t))
      return "I can send reminders, updates, and assistant-triggered notifications whenever you need a nudge.";
    if (/(voice|talk|speak|mic)/.test(t))
      return "Voice is built in — talk to me hands-free for quick help while you keep working.";
    if (/(plugin|connect|tool|api|integrat)/.test(t))
      return "The plugin system connects your tools, APIs, and workflows into one assistant.";
    if (/(price|cost|free|pay|subscri)/.test(t))
      return "Pricing and availability vary by release — the download section always shows the latest option.";
    if (/(hi|hello|hey|yo)\b/.test(t))
      return "Hey! I'm VibeSpace. Ask me about chat, voice, local models, plugins, or launching your next project.";
    return "I'm a quick demo of VibeSpace. Try a suggested prompt, or download the app to do this for real across chat, voice, and automation.";
  }
  function replyFor(text) {
    const key = text.trim().toLowerCase();
    return SCRIPTED[key] || keywordReply(text);
  }

  function addMessage(text, who) {
    if (!chatLog) return null;
    const msg = document.createElement('div');
    msg.className = `msg msg--${who}`;
    if (who === 'ai') {
      const label = document.createElement('span');
      label.className = 'msg__who';
      label.textContent = 'VibeSpace';
      msg.appendChild(label);
    }
    msg.appendChild(document.createTextNode(text));
    chatLog.appendChild(msg);
    chatLog.scrollTop = chatLog.scrollHeight;
    return msg;
  }
  function showTyping() {
    if (!chatLog) return null;
    const t = document.createElement('div');
    t.className = 'msg msg--ai typing';
    t.innerHTML = '<i></i><i></i><i></i>';
    t.setAttribute('aria-label', 'VibeSpace is typing');
    chatLog.appendChild(t);
    chatLog.scrollTop = chatLog.scrollHeight;
    return t;
  }

  let chatBusy = false;
  function vibeRespond(userText) {
    if (!chatLog) return;
    chatBusy = true;
    const typingEl = showTyping();
    const reply = replyFor(userText);
    const delay = prefersReduced ? 250 : Math.min(1500, 550 + reply.length * 12);
    setTimeout(() => {
      if (typingEl) typingEl.remove();
      addMessage(reply, 'ai');
      chatBusy = false;
    }, delay);
  }
  function sendUserMessage(text) {
    const clean = (text || '').trim();
    if (!clean || chatBusy) return;
    addMessage(clean, 'me');
    vibeRespond(clean);
  }

  function seedChat() {
    if (!chatLog) return;
    addMessage('Welcome back. I’m online and ready.', 'ai');
    addMessage('What can you help me with?', 'me');
    addMessage(
      'I can help you code, research, organize projects, automate workflows, call or message you, and connect tools into one command center.',
      'ai'
    );
  }
  seedChat();

  if (chatForm && chatField) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendUserMessage(chatField.value);
      chatField.value = '';
      chatField.focus();
    });
  }
  if (suggestWrap) {
    $$('.suggest', suggestWrap).forEach((btn) => {
      btn.addEventListener('click', () => sendUserMessage(btn.getAttribute('data-prompt') || btn.textContent));
    });
  }

  /* ------------------------- Contact form (mock) ------------------------- */
  /* BACKEND: replace the demo block with a fetch() POST to your endpoint.   */
  const contactForm    = $('#contactForm');
  const contactSuccess = $('#contactSuccess');

  function handleContactSubmit(e) {
    e.preventDefault();
    if (!contactForm.checkValidity()) { contactForm.reportValidity(); return; }
    // --- demo behavior ---
    if (contactSuccess) contactSuccess.hidden = false;
    toast('Message captured ✓');
    contactForm.reset();
    // --- end demo behavior ---
  }
  if (contactForm) {
    contactForm.addEventListener('submit', handleContactSubmit);
    contactForm.addEventListener('input', () => {
      if (contactSuccess && !contactSuccess.hidden) contactSuccess.hidden = true;
    });
  }

  /* ----------------------- Install OS tab switcher ----------------------- */
  const installTabs   = $$('.install__tab');
  const installPanels = $$('.install__panel');
  installTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const os = tab.getAttribute('data-os');
      installTabs.forEach((t) => t.classList.toggle('is-active', t === tab));
      installPanels.forEach((p) => {
        const match = p.getAttribute('data-os') === os;
        p.classList.toggle('is-active', match);
        p.hidden = !match;
      });
    });
  });

  /* ----------------------- Copy-to-clipboard buttons --------------------- */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // fallback for file:// previews and older browsers
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta); resolve();
      } catch (e) { reject(e); }
    });
  }
  $$('.cmd__copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.parentElement ? btn.parentElement.querySelector('.cmd__code') : null;
      const text = code ? code.textContent.trim() : '';
      if (!text) return;
      copyText(text).then(() => {
        const original = btn.textContent;
        btn.textContent = 'Copied ✓';
        btn.classList.add('is-copied');
        toast('Command copied');
        setTimeout(() => { btn.textContent = original; btn.classList.remove('is-copied'); }, 1800);
      }).catch(() => toast('Press Ctrl/Cmd + C to copy'));
    });
  });

  /* ----------------------- Interactive phone demo ----------------------- */
  const phoneStage = $('#phone');
  if (phoneStage) {
    const tabs   = $$('.phone__tab', phoneStage);
    const views  = $$('.phone__view', phoneStage);
    const timerEl   = $('#callTimer');
    const captionEl = $('#callCaption');
    const thread    = $('#smsThread');

    const captions = [
      '“Scheduling your 9am review call.”',
      '“Tests passed — deploying now.”',
      '“Pushed the fix and updated the notes.”',
      '“Your launch checklist is ready when you are.”',
    ];
    const smsScript = [
      { who: 'me', text: 'Deploy the new build when tests pass.' },
      { who: 'ai', text: 'On it — running the tests now. ✅' },
      { who: 'ai', text: 'All green. Shipping to production…' },
      { who: 'me', text: 'Nice. Text me when it’s live.' },
      { who: 'ai', text: 'Live 🎉 I’ll watch for errors and ping you if anything spikes.' },
    ];

    let secs = 0, current = 'call';
    let timerId = null, capId = null, capIdx = 0, smsId = null, autoId = null, running = false;
    const fmt = (n) => String(n).padStart(2, '0');

    function stopCall() { if (timerId) clearInterval(timerId); if (capId) clearInterval(capId); timerId = capId = null; }
    function startCall() {
      secs = 0; capIdx = 0;
      if (timerEl) timerEl.textContent = '00:00';
      if (captionEl) captionEl.textContent = captions[0];
      stopCall();
      if (prefersReduced) { if (timerEl) timerEl.textContent = '00:12'; return; }
      timerId = setInterval(() => {
        secs++; if (timerEl) timerEl.textContent = `${fmt(Math.floor(secs / 60))}:${fmt(secs % 60)}`;
      }, 1000);
      capId = setInterval(() => {
        capIdx = (capIdx + 1) % captions.length;
        if (captionEl) { captionEl.classList.remove('is-in'); void captionEl.offsetWidth; captionEl.textContent = captions[capIdx]; captionEl.classList.add('is-in'); }
      }, 3200);
    }

    function buildBubble(m) {
      const b = document.createElement('div');
      b.className = 'sms-bubble sms-bubble--' + (m.who === 'ai' ? 'ai' : 'me');
      b.textContent = m.text;
      return b;
    }
    function stopSms() { if (smsId) clearTimeout(smsId); smsId = null; }
    function startSms() {
      if (!thread) return;
      thread.innerHTML = '';
      stopSms();
      if (prefersReduced) { smsScript.forEach((m) => thread.appendChild(buildBubble(m))); return; }
      let i = 0;
      const add = () => {
        if (i >= smsScript.length) { smsId = setTimeout(() => { thread.innerHTML = ''; i = 0; add(); }, 2800); return; }
        const m = smsScript[i++];
        thread.appendChild(buildBubble(m));
        thread.scrollTop = thread.scrollHeight;
        smsId = setTimeout(add, m.who === 'ai' ? 1500 : 1100);
      };
      add();
    }

    function show(view) {
      current = view;
      tabs.forEach((t) => t.classList.toggle('is-active', t.getAttribute('data-view') === view));
      views.forEach((v) => { const match = v.getAttribute('data-view') === view; v.classList.toggle('is-active', match); v.hidden = !match; });
      if (view === 'call') { stopSms(); startCall(); } else { stopCall(); startSms(); }
    }
    function startAuto() { if (autoId) clearInterval(autoId); if (!prefersReduced) autoId = setInterval(() => show(current === 'call' ? 'sms' : 'call'), 8000); }
    function stopAll() { stopCall(); stopSms(); if (autoId) clearInterval(autoId); autoId = null; }

    tabs.forEach((t) => t.addEventListener('click', () => { show(t.getAttribute('data-view')); startAuto(); }));

    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting && !running) { running = true; show('call'); startAuto(); }
          else if (!e.isIntersecting && running) { running = false; stopAll(); }
        });
      }, { threshold: 0.3 });
      io.observe(phoneStage);
    } else { show('call'); startAuto(); }
  }
})();
