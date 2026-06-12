/* VibeSpace — vibespaceos.com
   Vanilla JS: scroll reveals, copy buttons, nav, scroll progress,
   and the simulated terminal demo. No dependencies. */

(() => {
  "use strict";

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

  /* ====================== simulated terminal ======================
     Types out a short VibeSpace session in a loop: a command, agent
     activity across terminals, then a voice exchange + phone call.   */
  const body = document.getElementById("termBody");
  const voiceBar = document.getElementById("termVoice");
  const voiceText = document.getElementById("termVoiceText");

  if (body) {
    // Each step: { text, cls, type: "type" | "print", pause, voice }
    const SCRIPT = [
      { type: "print", cls: "t-dim", text: "VibeSpace · terminal 1 — session restored from yesterday, 4:32 PM" },
      { type: "type", pre: "PS C:\\projects\\nebula> ", preCls: "t-prompt", cls: "t-cmd", text: "jarvis \u201Cship the landing page\u201D", pause: 600 },
      { type: "print", cls: "t-accent", text: "◆ Jarvis — planning across 3 terminals…", pause: 650 },
      { type: "print", cls: "t-dim", text: "  ├─ task board created · 4 steps", pause: 420 },
      { type: "print", cls: "t-ok", text: "  ├─ terminal 2 → pnpm build … done in 12.4s ✓", pause: 520 },
      { type: "print", cls: "t-ok", text: "  ├─ terminal 3 → deploy to pages … live ✓", pause: 520 },
      { type: "print", cls: "t-dim", text: "  └─ memory updated · context map synced", pause: 700 },
      { type: "print", cls: "t-accent", text: "● Jarvis: \u201CDone — the site is live. Want me to call you when DNS finishes propagating?\u201D", pause: 850 },
      { type: "voice", text: "\u201CHey Jarvis — yes, call my phone.\u201D", pause: 2300 },
      { type: "print", cls: "t-voice", text: "◉ voice — \u201CHey Jarvis — yes, call my phone.\u201D", pause: 500 },
      { type: "print", cls: "t-ok", text: "☎ scheduling call → +1 ••• ••• 4821 … confirmed ✓", pause: 3600 },
    ];

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const addLine = (html, cls) => {
      const el = document.createElement("span");
      el.className = "t-line" + (cls ? " " + cls : "");
      el.innerHTML = html;
      body.appendChild(el);
      // keep at most ~16 lines so loops don't grow the page
      while (body.children.length > 16) body.removeChild(body.firstChild);
      return el;
    };

    const typeLine = async (step) => {
      const el = addLine("", step.cls);
      const pre = step.pre
        ? `<span class="${step.preCls || ""}">${step.pre}</span>`
        : "";
      const caret = '<span class="t-caret"></span>';
      for (let i = 0; i <= step.text.length; i++) {
        el.innerHTML = pre + step.text.slice(0, i) + caret;
        await sleep(26 + Math.random() * 34);
      }
      el.innerHTML = pre + step.text;
    };

    const showVoice = async (text, ms) => {
      if (!voiceBar || !voiceText) return;
      voiceText.textContent = "";
      voiceBar.hidden = false;
      for (let i = 0; i <= text.length; i++) {
        voiceText.textContent = text.slice(0, i);
        await sleep(34);
      }
      await sleep(ms);
      voiceBar.hidden = true;
    };

    const run = async () => {
      // Reduced motion: render the finished session statically, once.
      if (reducedMotion) {
        for (const s of SCRIPT) {
          if (s.type === "voice") continue;
          const pre = s.pre ? `<span class="${s.preCls || ""}">${s.pre}</span>` : "";
          addLine(pre + s.text, s.cls);
        }
        return;
      }
      // Start when the demo scrolls into view.
      await new Promise((resolve) => {
        const io = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            io.disconnect();
            resolve();
          }
        }, { threshold: 0.25 });
        io.observe(body);
      });

      for (;;) {
        body.innerHTML = "";
        for (const step of SCRIPT) {
          if (step.type === "voice") {
            await showVoice(step.text, step.pause || 1500);
          } else if (step.type === "type") {
            await typeLine(step);
            await sleep(step.pause || 300);
          } else {
            addLine(
              (step.pre ? `<span class="${step.preCls || ""}">${step.pre}</span>` : "") + step.text,
              step.cls
            );
            await sleep(step.pause || 300);
          }
        }
        await sleep(1200);
      }
    };

    run();
  }
})();
