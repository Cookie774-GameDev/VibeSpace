/* desktop-os.js — VibeSpace Desktop simulator
 * Boot → desktop → window manager → apps:
 * Terminal, Chat, Voice, Settings, Game, Inspector, Skills, Hive
 */
(function () {
  "use strict";
  var reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;
  var frame, wallpaper, windows, dock, menubar, clock;
  var zCounter = 10;
  var openWindows = {};
  var termTabs = {};
  var termTabCounter = 0;
  var gameInterval = null;

  function init() {
    frame = document.getElementById("desktopOS");
    if (!frame) return;
    if (frame.dataset.vsClone === "true") {
      initWorkspaceClone(frame);
      return;
    }
    wallpaper = frame.querySelector(".desktop-wallpaper");
    windows = frame.querySelector(".desktop-windows");
    dock = frame.querySelector(".desktop-dock");
    menubar = frame.querySelector(".desktop-menubar");
    clock = frame.querySelector(".mb-clock");

    var boot = frame.querySelector(".desktop-boot");
    if (boot) {
      setTimeout(function () { boot.classList.add("done"); }, reduce ? 100 : 2200);
    }

    updateClock();
    setInterval(updateClock, 1000);

    if (dock) {
      dock.querySelectorAll(".dock-icon").forEach(function (icon) {
        icon.addEventListener("click", function () { openApp(icon.dataset.app); });
      });
    }

    if (menubar) {
      menubar.querySelectorAll(".mb-menu").forEach(function (menu) {
        menu.addEventListener("click", function (e) {
          e.stopPropagation();
          var wasActive = menu.classList.contains("active");
          menubar.querySelectorAll(".mb-menu").forEach(function (m) { m.classList.remove("active"); });
          if (!wasActive) menu.classList.add("active");
        });
      });
      document.addEventListener("click", function () {
        if (menubar) menubar.querySelectorAll(".mb-menu").forEach(function (m) { m.classList.remove("active"); });
      });
      menubar.querySelectorAll(".mb-item").forEach(function (item) {
        item.addEventListener("click", function () {
          var action = item.dataset.action;
          menubar.querySelectorAll(".mb-menu").forEach(function (m) { m.classList.remove("active"); });
          if (action) handleMenuAction(action);
        });
      });
    }

    if (!reduce && matchMedia("(pointer:fine)").matches) {
      frame.addEventListener("mousemove", desktopParallax);
    }

    setTimeout(function () { openApp("terminal"); }, reduce ? 200 : 2500);
  }

  function desktopParallax(e) {
    var rect = frame.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width - 0.5;
    var y = (e.clientY - rect.top) / rect.height - 0.5;
    if (wallpaper) wallpaper.style.transform = "translate(" + x * 8 + "px, " + y * 8 + "px)";
  }

  function updateClock() {
    if (!clock) return;
    var customTime = sessionStorage.getItem("vs-desktop-time");
    var d = customTime ? new Date(customTime) : new Date();
    if (isNaN(d)) d = new Date();
    var days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    var h = d.getHours();
    var m = d.getMinutes();
    clock.textContent = days[d.getDay()] + " " + (h % 12 || 12) + ":" + (m < 10 ? "0" : "") + m;
  }

  function handleMenuAction(action) {
    if (action === "open-terminal") openApp("terminal");
    else if (action === "open-chat") openApp("chat");
    else if (action === "open-voice") openApp("voice");
    else if (action === "open-settings") openApp("settings");
    else if (action === "open-game") openApp("game");
    else if (action === "open-inspector") openApp("inspector");
    else if (action === "open-skills") openApp("skills");
    else if (action === "open-hive") openApp("hive");
    else if (action === "about") openApp("settings");
  }

  var appConfigs = {
    terminal: { title: "Terminal", w: 340, h: 210, x: 25, y: 15 },
    chat: { title: "Chat — Jarvis", w: 310, h: 250, x: 90, y: 35 },
    voice: { title: "Voice — Jarvis", w: 230, h: 190, x: 160, y: 55 },
    settings: { title: "Settings", w: 290, h: 230, x: 130, y: 25 },
    game: { title: "Ship the Build", w: 290, h: 230, x: 110, y: 45 },
    inspector: { title: "Inspector", w: 320, h: 250, x: 80, y: 30 },
    skills: { title: "Skills Catalog", w: 330, h: 250, x: 50, y: 40 },
    hive: { title: "Hive Visualizer", w: 340, h: 240, x: 100, y: 20 }
  };

  function openApp(appId) {
    if (openWindows[appId]) {
      var w = openWindows[appId];
      w.classList.remove("minimized");
      focusWindow(w);
      return;
    }
    var cfg = appConfigs[appId];
    if (!cfg) return;
    var win = createWindow(appId, cfg);
    windows.appendChild(win);
    openWindows[appId] = win;
    var dockIcon = dock.querySelector('[data-app="' + appId + '"]');
    if (dockIcon) dockIcon.classList.add("running");
    setTimeout(function () {
      if (appId === "terminal") initTerminal(win);
      else if (appId === "chat") initChat(win);
      else if (appId === "voice") initVoice(win);
      else if (appId === "settings") initSettings(win);
      else if (appId === "game") initGame(win);
      else if (appId === "inspector") initInspector(win);
      else if (appId === "skills") initSkills(win);
      else if (appId === "hive") initHive(win);
    }, 50);
  }

  function createWindow(appId, cfg) {
    var win = document.createElement("div");
    win.className = "dw-window";
    win.dataset.app = appId;
    win.style.width = cfg.w + "px";
    win.style.height = cfg.h + "px";
    win.style.left = cfg.x + "px";
    win.style.top = cfg.y + "px";
    win.style.zIndex = ++zCounter;
    win.innerHTML =
      '<div class="dw-titlebar">' +
        '<button class="dw-tl-btn dw-tl-close" aria-label="Close"></button>' +
        '<button class="dw-tl-btn dw-tl-min" aria-label="Minimize"></button>' +
        '<button class="dw-tl-btn dw-tl-max" aria-label="Maximize"></button>' +
        '<span class="dw-title">' + cfg.title + '</span>' +
      '</div>' +
      '<div class="dw-body"></div>';
    setTimeout(function () { win.classList.add("open"); }, 10);

    var titlebar = win.querySelector(".dw-titlebar");
    dragWindow(win, titlebar);
    win.addEventListener("mousedown", function () { focusWindow(win); });

    win.querySelector(".dw-tl-close").addEventListener("click", function (e) {
      e.stopPropagation(); closeWindow(win);
    });
    win.querySelector(".dw-tl-min").addEventListener("click", function (e) {
      e.stopPropagation(); win.classList.add("minimized");
    });
    win.querySelector(".dw-tl-max").addEventListener("click", function (e) {
      e.stopPropagation();
      if (win.dataset.maximized === "1") {
        win.style.width = cfg.w + "px"; win.style.height = cfg.h + "px";
        win.style.left = cfg.x + "px"; win.style.top = cfg.y + "px";
        win.dataset.maximized = "0";
      } else {
        win.style.width = "calc(100% - 8px)"; win.style.height = "calc(100% - 8px)";
        win.style.left = "4px"; win.style.top = "4px";
        win.dataset.maximized = "1";
      }
    });
    return win;
  }

  function dragWindow(win, handle) {
    var isDragging = false, startX, startY, initX, initY;
    handle.addEventListener("mousedown", function (e) {
      if (e.target.classList.contains("dw-tl-btn")) return;
      isDragging = true;
      startX = e.clientX; startY = e.clientY;
      initX = parseInt(win.style.left); initY = parseInt(win.style.top);
      focusWindow(win); e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!isDragging) return;
      win.style.left = (initX + e.clientX - startX) + "px";
      win.style.top = Math.max(0, initY + e.clientY - startY) + "px";
    });
    document.addEventListener("mouseup", function () { isDragging = false; });
    handle.addEventListener("touchstart", function (e) {
      if (e.target.classList.contains("dw-tl-btn")) return;
      isDragging = true;
      var t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      initX = parseInt(win.style.left); initY = parseInt(win.style.top);
      focusWindow(win);
    });
    document.addEventListener("touchmove", function (e) {
      if (!isDragging) return;
      var t = e.touches[0];
      win.style.left = (initX + t.clientX - startX) + "px";
      win.style.top = Math.max(0, initY + t.clientY - startY) + "px";
    });
    document.addEventListener("touchend", function () { isDragging = false; });
  }

  function focusWindow(win) { win.style.zIndex = ++zCounter; }

  function closeWindow(win) {
    var appId = win.dataset.app;
    win.classList.add("closing");
    setTimeout(function () {
      win.remove();
      delete openWindows[appId];
      var dockIcon = dock.querySelector('[data-app="' + appId + '"]');
      if (dockIcon) dockIcon.classList.remove("running");
      if (appId === "game" && gameInterval) { clearInterval(gameInterval); gameInterval = null; }
    }, 200);
  }

  function escapeHtml(s) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function showToast(msg) {
    var toast = frame.querySelector(".desktop-toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(function () { toast.classList.remove("show"); }, 2500);
  }

  // ============ TERMINAL ============
  function initTerminal(win) {
    var body = win.querySelector(".dw-body");
    body.innerHTML =
      '<div class="dw-terminal">' +
        '<div class="term-tabbar">' +
          '<div class="term-tab active" data-tab="1">bash <span class="term-tab-close">x</span></div>' +
          '<button class="term-tab-add" aria-label="New tab">+</button>' +
        '</div>' +
        '<div class="term-output" data-tab="1"></div>' +
        '<div class="term-input-row">' +
          '<span class="ti-prompt">$</span>' +
          '<input class="term-input" type="text" autocomplete="off" spellcheck="false" />' +
        '</div>' +
      '</div>';

    var tabId = ++termTabCounter;
    termTabs[tabId] = { history: [] };
    body.querySelector(".term-tab").dataset.tab = tabId;
    body.querySelector(".term-output").dataset.tab = tabId;

    printTermLine(body, tabId, '<span class="to-mu">VibeSpace Terminal v0.1.45 -- type <span class="to-cu">help</span> to start</span>');
    printTermLine(body, tabId, '<span class="to-mu">Agent coordination: Scout / Builder / Reviewer -- OpenCode ready</span>');

    var input = body.querySelector(".term-input");
    input.focus();
    body.addEventListener("click", function () { input.focus(); });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        var cmd = input.value.trim();
        input.value = "";
        handleTermCommand(body, tabId, cmd);
      }
    });

    body.querySelector(".term-tab-add").addEventListener("click", function () {
      var newId = ++termTabCounter;
      termTabs[newId] = { history: [] };
      var tabBar = body.querySelector(".term-tabbar");
      var newTab = document.createElement("div");
      newTab.className = "term-tab";
      newTab.dataset.tab = newId;
      newTab.innerHTML = 'bash <span class="term-tab-close">x</span>';
      tabBar.insertBefore(newTab, tabBar.querySelector(".term-tab-add"));
      var newOutput = document.createElement("div");
      newOutput.className = "term-output";
      newOutput.dataset.tab = newId;
      newOutput.style.display = "none";
      body.querySelector(".dw-terminal").insertBefore(newOutput, body.querySelector(".term-input-row"));
      printTermLine(body, newId, '<span class="to-mu">New tab -- type <span class="to-cu">help</span></span>');
      switchTermTab(body, newId);
      input.focus();
    });

    body.querySelector(".term-tabbar").addEventListener("click", function (e) {
      if (e.target.classList.contains("term-tab-add")) return;
      if (e.target.classList.contains("term-tab-close")) {
        e.stopPropagation();
        var tab = e.target.closest(".term-tab");
        if (body.querySelectorAll(".term-tab").length <= 1) return;
        var tid = tab.dataset.tab;
        tab.remove();
        var out = body.querySelector('.term-output[data-tab="' + tid + '"]');
        if (out) out.remove();
        var firstTab = body.querySelector(".term-tab");
        if (firstTab) switchTermTab(body, firstTab.dataset.tab);
        return;
      }
      var tab = e.target.closest(".term-tab");
      if (tab) switchTermTab(body, tab.dataset.tab);
    });
  }

  function switchTermTab(body, tabId) {
    body.querySelectorAll(".term-tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.tab == tabId);
    });
    body.querySelectorAll(".term-output").forEach(function (o) {
      o.style.display = o.dataset.tab == tabId ? "block" : "none";
    });
  }

  function printTermLine(body, tabId, html) {
    var output = body.querySelector('.term-output[data-tab="' + tabId + '"]');
    if (!output) return;
    var div = document.createElement("div");
    div.innerHTML = html;
    output.appendChild(div);
    output.scrollTop = output.scrollHeight;
    var input = body.querySelector(".term-input");
    if (input) input.focus();
  }

  function handleTermCommand(body, tabId, cmd) {
    printTermLine(body, tabId, '<span class="to-pr">$</span> ' + escapeHtml(cmd));
    var main = cmd.toLowerCase().split(/\s+/)[0];
    var arg = cmd.toLowerCase().split(/\s+/).slice(1).join(" ");

    if (main === "help") {
      printTermLine(body, tabId, '<span class="to-ok">Commands:</span>');
      printTermLine(body, tabId, '  <span class="to-cu">help</span>     List commands');
      printTermLine(body, tabId, '  <span class="to-cu">jarvis</span>   Boot message + features');
      printTermLine(body, tabId, '  <span class="to-cu">open terminal</span>  Spawn new tab');
      printTermLine(body, tabId, '  <span class="to-cu">hive</span> [fast|balanced|quality]  Stack output');
      printTermLine(body, tabId, '  <span class="to-cu">skills</span>   List 6 skills');
      printTermLine(body, tabId, '  <span class="to-cu">clear</span>    Clear screen');
      printTermLine(body, tabId, '  <span class="to-cu">date</span>     Show current date/time');
      printTermLine(body, tabId, '  <span class="to-cu">vibe</span>     Easter egg');
      printTermLine(body, tabId, '  <span class="to-cu">install</span>  Install one-liner');
      printTermLine(body, tabId, '<span class="to-mu">Tip: agent coordination uses Rust-backed ledger. Try /skills in chat too.</span>');
    } else if (main === "jarvis") {
      printTermLine(body, tabId, '<span class="to-cu">Booting VibeSpace...</span>');
      printTermLine(body, tabId, '<span class="to-ok">  + 21+ model providers ready</span>');
      printTermLine(body, tabId, '<span class="to-ok">  + Local voice: Jarvis + Friday (Kokoro, free)</span>');
      printTermLine(body, tabId, '<span class="to-ok">  + Terminal swarm online (PTY grid)</span>');
      printTermLine(body, tabId, '<span class="to-ok">  + Skills catalog loaded (/skills)</span>');
      printTermLine(body, tabId, '<span class="to-ok">  + Inspector + Kanban ready (v0.1.45)</span>');
      printTermLine(body, tabId, '<span class="to-ok">  + Memory + context maps scoped per project</span>');
      printTermLine(body, tabId, '<span class="to-mu">  Jarvis is the voice assistant -- not the product name.</span>');
    } else if (main === "open") {
      if (arg === "terminal") {
        body.querySelector(".term-tab-add").click();
        printTermLine(body, tabId, '<span class="to-ok">  + New terminal tab spawned</span>');
      } else {
        printTermLine(body, tabId, '<span class="to-err">  Unknown: open ' + escapeHtml(arg) + '</span>');
      }
    } else if (main === "hive") {
      if (arg === "fast") {
        printTermLine(body, tabId, '<span class="to-cu">Hive Stack -- Fast</span>');
        printTermLine(body, tabId, '<span class="to-mu">  Step 1: Groq Llama (draft) -> </span><span class="to-ok">120ms</span>');
        printTermLine(body, tabId, '<span class="to-mu">  Step 2: Cerebras (refine) -> </span><span class="to-ok">80ms</span>');
        printTermLine(body, tabId, '<span class="to-ok">  + Response synthesized in 200ms</span>');
      } else if (arg === "balanced") {
        printTermLine(body, tabId, '<span class="to-cu">Hive Stack -- Balanced</span>');
        printTermLine(body, tabId, '<span class="to-mu">  Step 1: GPT-4o-mini (draft) -> </span><span class="to-ok">340ms</span>');
        printTermLine(body, tabId, '<span class="to-mu">  Step 2: Claude Haiku (refine) -> </span><span class="to-ok">520ms</span>');
        printTermLine(body, tabId, '<span class="to-ok">  + Synthesized in 860ms</span>');
      } else if (arg === "quality") {
        printTermLine(body, tabId, '<span class="to-cu">Hive Stack -- Quality</span>');
        printTermLine(body, tabId, '<span class="to-mu">  Step 1: Claude Sonnet (draft) -> </span><span class="to-ok">1.2s</span>');
        printTermLine(body, tabId, '<span class="to-mu">  Step 2: GPT-4o (refine) -> </span><span class="to-ok">1.8s</span>');
        printTermLine(body, tabId, '<span class="to-mu">  Step 3: Critic (review) -> </span><span class="to-ok">0.4s</span>');
        printTermLine(body, tabId, '<span class="to-ok">  + Synthesized in 3.4s -- Critic approved</span>');
      } else {
        printTermLine(body, tabId, '<span class="to-mu">Usage: hive [fast|balanced|quality]</span>');
        printTermLine(body, tabId, '<span class="to-mu">Presets: Fast, Balanced, Quality, High, Custom</span>');
      }
    } else if (main === "skills") {
      printTermLine(body, tabId, '<span class="to-cu">== Skills Catalog (6 of many) ==</span>');
      printTermLine(body, tabId, '  1. <span class="to-ok">code-reviewer</span>  Review diffs, find gaps, block unclean merges');
      printTermLine(body, tabId, '  2. <span class="to-ok">scout-scanner</span>  Scan codebase, identify changes, route to builder');
      printTermLine(body, tabId, '  3. <span class="to-ok">research-synth</span>  Read docs, cite evidence, synthesize findings');
      printTermLine(body, tabId, '  4. <span class="to-ok">ship-the-build</span>  Run tests, build, deploy with approve/cancel cards');
      printTermLine(body, tabId, '  5. <span class="to-ok">voice-summary</span>  Summarize files via Jarvis voice, hands-free');
      printTermLine(body, tabId, '  6. <span class="to-ok">context-keeper</span>  Persist project context across sessions');
      printTermLine(body, tabId, '<span class="to-mu">  Use /skills in chat to pick one. SkillEditor has markdown preview.</span>');
    } else if (main === "clear") {
      var output = body.querySelector('.term-output[data-tab="' + tabId + '"]');
      if (output) output.innerHTML = "";
    } else if (main === "date") {
      var customTime = sessionStorage.getItem("vs-desktop-time");
      var d = customTime ? new Date(customTime) : new Date();
      if (isNaN(d)) d = new Date();
      printTermLine(body, tabId, '<span class="to-cu">' + d.toString() + '</span>');
    } else if (main === "vibe") {
      printTermLine(body, tabId, '<span class="to-cu">  V I B E S P A C E</span>');
      printTermLine(body, tabId, '<span class="to-mu">  Vibe coding for vibe coders.</span>');
    } else if (main === "install") {
      printTermLine(body, tabId, '<span class="to-cu"># Windows (PowerShell)</span>');
      printTermLine(body, tabId, '  irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex');
      printTermLine(body, tabId, '<span class="to-cu"># macOS / Linux</span>');
      printTermLine(body, tabId, '  curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.sh | bash');
      printTermLine(body, tabId, '<span class="to-mu">  One line. The right installer. Your keys. Your machine.</span>');
    } else if (main === "") {
      // no-op
    } else {
      printTermLine(body, tabId, '<span class="to-err">  command not found: ' + escapeHtml(main) + '</span>');
      printTermLine(body, tabId, '<span class="to-mu">  Type help for available commands</span>');
    }
    var input = body.querySelector(".term-input");
    if (input) input.focus();
  }

  // ============ CHAT ============
  function initChat(win) {
    var body = win.querySelector(".dw-body");
    body.innerHTML =
      '<div class="dw-chat" style="position:relative">' +
        '<div class="chat-header"><span class="ch-avatar">J</span> Jarvis <span style="color:var(--sage);font-size:10px;margin-left:auto">online</span></div>' +
        '<div class="chat-body"></div>' +
        '<div class="chat-hint">Try: <code>/skills</code></div>' +
        '<div class="chat-input-row">' +
          '<input class="chat-input" type="text" placeholder="Type a message or /skills..." />' +
          '<button class="chat-send" aria-label="Send">></button>' +
        '</div>' +
      '</div>';

    var chatBody = body.querySelector(".chat-body");
    var input = body.querySelector(".chat-input");
    var sendBtn = body.querySelector(".chat-send");
    var hint = body.querySelector(".chat-hint");

    addChatMsg(chatBody, "them", "Hey! I'm Jarvis -- your voice assistant inside VibeSpace. Ask me about voice, calls, terminals, skills, or memory.");
    addChatMsg(chatBody, "them", "Try typing /skills to browse the catalog, or just ask me anything.");

    function send() {
      var text = input.value.trim();
      if (!text) return;
      addChatMsg(chatBody, "you", text);
      input.value = "";
      hint.classList.remove("show");

      if (text.indexOf("/skills") === 0) {
        setTimeout(function () {
          addChatMsg(chatBody, "them", "Skills catalog: code-reviewer, scout-scanner, research-synth, ship-the-build, voice-summary, context-keeper");
          var chip = document.createElement("div");
          chip.className = "chat-msg them show";
          chip.innerHTML = '<span class="chat-chip">/skills coding</span> <span class="chat-chip">/skills voice</span> <span class="chat-chip">/skills research</span>';
          chatBody.appendChild(chip);
          chatBody.scrollTop = chatBody.scrollHeight;
        }, 500);
        return;
      }

      setTimeout(function () {
        var reply = window.VSDialogue ? VSDialogue.getReply("jarvis", text) : "I'm Jarvis.";
        addChatMsg(chatBody, "them", reply);
      }, 600);
    }

    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); send(); }
    });
    input.addEventListener("input", function () {
      if (input.value.indexOf("/") === 0) hint.classList.add("show");
      else hint.classList.remove("show");
    });
  }

  function addChatMsg(chatBody, side, text) {
    var div = document.createElement("div");
    div.className = "chat-msg " + side;
    div.textContent = text;
    chatBody.appendChild(div);
    setTimeout(function () { div.classList.add("show"); }, 30);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  // ============ VOICE ============
  function initVoice(win) {
    var body = win.querySelector(".dw-body");
    body.innerHTML =
      '<div class="dw-voice">' +
        '<div class="voice-orb">J</div>' +
        '<div class="voice-status">Tap to talk</div>' +
        '<div class="voice-viz">' +
          '<div class="vz-bar"></div><div class="vz-bar"></div><div class="vz-bar"></div>' +
          '<div class="vz-bar"></div><div class="vz-bar"></div><div class="vz-bar"></div><div class="vz-bar"></div>' +
        '</div>' +
        '<div class="voice-caption"></div>' +
      '</div>';
    var orb = body.querySelector(".voice-orb");
    var status = body.querySelector(".voice-status");
    var caption = body.querySelector(".voice-caption");
    var lines = [
      "Hey, it's Jarvis. Local Kokoro voice -- free and unlimited. No API key needed.",
      "Push-to-talk with Mod+Space. Wake word only activates in hands-free mode.",
      "I can search files, summarize docs, create tasks, and call you when builds fail."
    ];
    var lineIdx = 0;
    var isListening = false;

    orb.addEventListener("click", function () {
      if (isListening) return;
      isListening = true;
      orb.classList.add("listening");
      status.textContent = "Listening...";
      var line = lines[lineIdx % lines.length];
      lineIdx++;
      caption.innerHTML = "";
      if (!reduce) {
        var i = 0;
        var tick = setInterval(function () {
          caption.textContent = line.slice(0, ++i);
          if (i >= line.length) {
            clearInterval(tick);
            setTimeout(function () {
              orb.classList.remove("listening");
              status.textContent = "Tap to talk";
              isListening = false;
            }, 2000);
          }
        }, 30);
      } else {
        caption.textContent = line;
        setTimeout(function () {
          orb.classList.remove("listening");
          status.textContent = "Tap to talk";
          isListening = false;
        }, 2000);
      }
    });
  }

  // ============ SETTINGS ============
  function initSettings(win) {
    var body = win.querySelector(".dw-body");
    body.innerHTML =
      '<div class="dw-settings">' +
        '<h4>Appearance</h4>' +
        '<div class="set-row"><span class="sr-label">Dark mode</span><button class="set-toggle on" data-set="dark"></button></div>' +
        '<h4>Date &amp; Time</h4>' +
        '<div class="set-row"><span class="sr-label">Custom time</span><input class="set-input ps-desktop-time" type="datetime-local" /></div>' +
        '<h4>Audio</h4>' +
        '<div class="set-row"><span class="sr-label">Volume</span><input class="set-slider" type="range" min="0" max="100" value="75" /></div>' +
        '<h4>About</h4>' +
        '<div class="set-about">VibeSpace v0.1.45<br/>Apache 2.0 / Local-first / Built by a vibe coder</div>' +
      '</div>';
    var timeInput = body.querySelector(".ps-desktop-time");
    if (timeInput) {
      var saved = sessionStorage.getItem("vs-desktop-time");
      if (saved) timeInput.value = saved;
      timeInput.addEventListener("change", function () {
        sessionStorage.setItem("vs-desktop-time", timeInput.value);
        updateClock();
        showToast("Clock updated");
      });
    }
    var darkToggle = body.querySelector('[data-set="dark"]');
    if (darkToggle) darkToggle.addEventListener("click", function () { darkToggle.classList.toggle("on"); });
  }

  // ============ GAME ============
  function initGame(win) {
    var body = win.querySelector(".dw-body");
    body.innerHTML =
      '<div class="dw-game" style="position:relative">' +
        '<div class="game-header">' +
          '<span class="game-score">Score: 0</span>' +
          '<button class="game-start-btn">Start</button>' +
        '</div>' +
        '<div class="game-instructions">Arrow keys to collect the build tokens</div>' +
        '<canvas class="game-canvas" width="276" height="160"></canvas>' +
        '<div class="game-toast"></div>' +
      '</div>';
    var canvas = body.querySelector(".game-canvas");
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    var scoreEl = body.querySelector(".game-score");
    var startBtn = body.querySelector(".game-start-btn");
    var toast = body.querySelector(".game-toast");
    var snake, food, dir, score, tokens, running;

    function reset() {
      snake = [{ x: 60, y: 80 }];
      dir = { x: 1, y: 0 };
      score = 0;
      tokens = 5;
      placeFood();
      running = false;
      scoreEl.textContent = "Score: 0";
      draw();
    }
    function placeFood() {
      food = {
        x: Math.floor(Math.random() * (W - 20) + 10),
        y: Math.floor(Math.random() * (H - 20) + 10)
      };
    }
    function draw() {
      ctx.fillStyle = "#0c0a08";
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(80,72,66,0.3)";
      for (var x = 0; x < W; x += 20) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (var y = 0; y < H; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
      if (food) {
        ctx.fillStyle = "#9CC68B";
        ctx.font = "14px JetBrains Mono";
        ctx.fillText("+", food.x, food.y + 12);
      }
      snake.forEach(function (s, i) {
        ctx.fillStyle = i === 0 ? "#E0925C" : "#C5764A";
        ctx.fillRect(s.x, s.y, 12, 12);
      });
    }
    function tick() {
      if (!running) return;
      var head = { x: snake[0].x + dir.x * 12, y: snake[0].y + dir.y * 12 };
      if (head.x < 0) head.x = W;
      if (head.x > W) head.x = 0;
      if (head.y < 0) head.y = H;
      if (head.y > H) head.y = 0;
      snake.unshift(head);
      if (food && Math.abs(head.x - food.x) < 12 && Math.abs(head.y - food.y) < 12) {
        score++;
        tokens--;
        scoreEl.textContent = "Score: " + score;
        if (tokens <= 0) {
          running = false;
          if (gameInterval) { clearInterval(gameInterval); gameInterval = null; }
          toast.innerHTML = "Build shipped<br>Just like VibeSpace.";
          toast.classList.add("show");
          sessionStorage.setItem("vs-game-score", String(score));
          setTimeout(function () { toast.classList.remove("show"); }, 3000);
          startBtn.textContent = "Play Again";
          reset();
        } else {
          placeFood();
        }
      } else {
        snake.pop();
      }
      draw();
    }
    function start() {
      if (gameInterval) { clearInterval(gameInterval); gameInterval = null; }
      reset();
      running = true;
      startBtn.textContent = "Running...";
      gameInterval = setInterval(tick, reduce ? 200 : 120);
    }
    startBtn.addEventListener("click", start);
    var keyHandler = function (e) {
      if (!running) return;
      if (!openWindows.game) return;
      var k = e.key;
      if (k === "ArrowUp" && dir.y === 0) dir = { x: 0, y: -1 };
      else if (k === "ArrowDown" && dir.y === 0) dir = { x: 0, y: 1 };
      else if (k === "ArrowLeft" && dir.x === 0) dir = { x: -1, y: 0 };
      else if (k === "ArrowRight" && dir.x === 0) dir = { x: 1, y: 0 };
      if (k.indexOf("Arrow") === 0) e.preventDefault();
    };
    document.addEventListener("keydown", keyHandler);
    win._keyHandler = keyHandler;
    reset();
    var bestScore = sessionStorage.getItem("vs-game-score");
    if (bestScore) {
      body.querySelector(".game-instructions").textContent = "Best score: " + bestScore + " -- arrow keys to play";
    }
  }

  // ============ INSPECTOR ============
  function initInspector(win) {
    var body = win.querySelector(".dw-body");
    body.innerHTML =
      '<div class="dw-inspector" style="display:flex;flex-direction:column;height:100%;background:var(--bg-2,#292420);overflow-y:auto">' +
        '<div style="padding:10px 14px;border-bottom:1px solid var(--border)"><div style="display:flex;gap:4px;flex-wrap:wrap">' +
          '<button class="ins-tab active" data-tab="today">Today</button>' +
          '<button class="ins-tab" data-tab="trace">Trace</button>' +
          '<button class="ins-tab" data-tab="kanban">Kanban</button>' +
          '<button class="ins-tab" data-tab="schedule">Schedule</button>' +
        '</div></div>' +
        '<div class="ins-content" style="flex:1;overflow-y:auto;padding:10px 14px"></div>' +
        '<button class="ins-refresh" style="margin:8px 14px;padding:6px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--copper-soft);cursor:pointer;font-size:12px;font-family:inherit">Refresh trace</button>' +
      '</div>';

    var content = body.querySelector(".ins-content");
    var tabs = body.querySelectorAll(".ins-tab");
    var refreshBtn = body.querySelector(".ins-refresh");
    var currentTab = "today";

    var traceEvents = [
      { time: "12:01:43", agent: "Scout", action: "Scanned src/ -- 3 files changed", color: "cyan" },
      { time: "12:01:45", agent: "Builder", action: "Patching auth.ts -- token refresh", color: "plum" },
      { time: "12:02:10", agent: "Reviewer", action: "2 issues found -- missing test case", color: "amber" },
      { time: "12:02:38", agent: "Critic", action: "Blocked merge -- edge case: null token", color: "copper" },
      { time: "12:03:01", agent: "Builder", action: "Added null guard + test case", color: "plum" },
      { time: "12:03:22", agent: "Critic", action: "Approved -- ship it", color: "sage" }
    ];

    var kanbanCols = [
      { id: "todo", name: "To-do", color: "var(--cyan)", items: [{ t: "Refactor voice router", id: 0 }, { t: "Add Apex tier UI", id: 1 }, { t: "Docs for skills catalog", id: 2 }] },
      { id: "active", name: "Active", color: "var(--plum)", items: [{ t: "Fix auth token refresh", id: 3 }, { t: "Skills marketplace scaffold", id: 4 }] },
      { id: "review", name: "Review", color: "var(--amber)", items: [{ t: "Terminal scrollback isolation", id: 5 }] },
      { id: "done", name: "Done", color: "var(--sage)", items: [{ t: "Inspector panel", id: 6 }, { t: "Kanban milestones", id: 7 }, { t: "Rust ledger", id: 8 }] }
    ];
    var nextTaskId = 9;
    var kanbanDragId = -1;
    var kanbanDragFromCol = "";

    function renderTab() {
      if (currentTab === "today") {
        content.innerHTML =
          '<div style="font-size:13px;color:var(--copper-soft);font-weight:600;margin-bottom:10px;font-family:Fraunces,serif">Today</div>' +
          '<div style="display:flex;flex-direction:column;gap:8px">' +
            '<div class="ins-card">Sessions: 4 active threads</div>' +
            '<div class="ins-card">Terminal panes: 3 running</div>' +
            '<div class="ins-card">Voice: Jarvis idle (Mod+Space)</div>' +
            '<div class="ins-card">Memory: 2.4MB across 12 projects</div>' +
            '<div class="ins-card">Skills: 6 loaded, 2 custom</div>' +
            '<div class="ins-card">Actions: 0 pending approval</div>' +
          '</div>';
      } else if (currentTab === "trace") {
        content.innerHTML = '<div style="font-size:13px;color:var(--copper-soft);font-weight:600;margin-bottom:10px;font-family:Fraunces,serif">Trace milestones</div>';
        traceEvents.forEach(function (ev) {
          var div = document.createElement("div");
          div.className = "ins-trace";
          var color = ev.color === "cyan" ? "var(--cyan)" : ev.color === "plum" ? "var(--plum)" : ev.color === "amber" ? "var(--amber)" : ev.color === "sage" ? "var(--sage)" : "var(--copper-soft)";
          div.innerHTML = '<span style="font-family:JetBrains Mono,monospace;font-size:10px;color:var(--faint)">' + ev.time + '</span> ' +
            '<span style="color:' + color + ';font-weight:600;font-size:11px"> ' + ev.agent + ' </span>' +
            '<span style="color:var(--muted);font-size:12px">' + ev.action + '</span>';
          content.appendChild(div);
        });
      } else if (currentTab === "kanban") {
        renderKanban();
      } else if (currentTab === "schedule") {
        renderSchedule();
      }
    }

    function renderKanban() {
      content.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
          '<div style="font-size:13px;color:var(--copper-soft);font-weight:600;font-family:Fraunces,serif">Kanban -- drag cards</div>' +
          '<button class="kanban-add" style="padding:4px 10px;border:1px solid var(--copper);border-radius:6px;background:rgba(224,146,92,0.12);color:var(--copper-soft);cursor:pointer;font-size:11px;font-weight:600;font-family:inherit">+ New task</button>' +
        '</div>' +
        '<div class="kanban-board" style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px"></div>';
      var board = content.querySelector(".kanban-board");
      kanbanCols.forEach(function (col) {
        var colDiv = document.createElement("div");
        colDiv.className = "kanban-col";
        colDiv.dataset.col = col.id;
        colDiv.style.cssText = "flex:0 0 125px;display:flex;flex-direction:column;gap:6px;min-height:60px;padding:6px;border:1px dashed transparent;transition:background .15s";
        colDiv.innerHTML = '<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:' + col.color + '"></span>' +
          '<span style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:600">' + col.name + '</span>' +
          '<span style="font-size:10px;color:var(--faint);margin-left:auto">' + col.items.length + '</span>' +
        '</div>';
        col.items.forEach(function (item) {
          var card = document.createElement("div");
          card.className = "ins-kanban-card";
          card.textContent = item.t;
          card.dataset.taskId = item.id;
          card.draggable = true;
          card.addEventListener("dragstart", function (e) {
            kanbanDragId = item.id;
            kanbanDragFromCol = col.id;
            e.dataTransfer.effectAllowed = "move";
            card.style.opacity = "0.5";
          });
          card.addEventListener("dragend", function () { card.style.opacity = "1"; });
          card.addEventListener("click", function () { showToast("Task: " + item.t); });
          colDiv.appendChild(card);
        });
        colDiv.addEventListener("dragover", function (e) {
          e.preventDefault();
          colDiv.style.background = "rgba(224,146,92,0.06)";
          colDiv.style.borderColor = "var(--copper)";
        });
        colDiv.addEventListener("dragleave", function () {
          colDiv.style.background = "";
          colDiv.style.borderColor = "transparent";
        });
        colDiv.addEventListener("drop", function (e) {
          e.preventDefault();
          colDiv.style.background = "";
          colDiv.style.borderColor = "transparent";
          moveToColumn(kanbanDragId, kanbanDragFromCol, col.id);
          renderKanban();
        });
        board.appendChild(colDiv);
      });
      var addBtn = content.querySelector(".kanban-add");
      if (addBtn) addBtn.addEventListener("click", function () {
        var names = ["Write changelog", "Audit auth flow", "Add voice preset", "Fix terminal geometry", "Tune Hive balanced", "Inspector unit tests"];
        var name = names[Math.floor(Math.random() * names.length)];
        kanbanCols[0].items.push({ t: name, id: nextTaskId++ });
        renderKanban();
        showToast("Task added: " + name);
      });
    }

    function moveToColumn(taskId, fromCol, toCol) {
      if (fromCol === toCol) return;
      var from = kanbanCols.find(function (c) { return c.id === fromCol; });
      var to = kanbanCols.find(function (c) { return c.id === toCol; });
      if (!from || !to) return;
      var idx = from.items.findIndex(function (i) { return i.id === taskId; });
      if (idx === -1) return;
      var item = from.items.splice(idx, 1)[0];
      to.items.push(item);
      if (toCol === "done") showToast("Shipped: " + item.t);
      else if (toCol === "review") showToast("Moved to review: " + item.t);
      else showToast(item.t + " -> " + to.name);
    }

    function renderSchedule() {
      var today = new Date();
      var hh = today.getHours();
      var m = today.getMinutes();
      var scheduledTasks = [
        { time: "06:30", label: "Morning standup", done: false, source: "Jarvis" },
        { time: "09:00", label: "Pair with Coder on auth.ts", done: false, source: "Builder" },
        { time: "11:00", label: "Research deep-dive: context maps", done: false, source: "Sage" },
        { time: "13:30", label: "Critic review of JWT diff", done: false, source: "Critic" },
        { time: "16:00", label: "Ship build v0.1.45", done: false, source: "DevRel Bot" },
        { time: "18:00", label: "Jarvis evening summary call", done: false, source: "Jarvis" }
      ];
      var stored = sessionStorage.getItem("vs-schedule");
      if (stored) { try { scheduledTasks = JSON.parse(stored); } catch (e) {} }

      var taskInput = '<div style="display:flex;gap:6px;margin-bottom:10px">' +
        '<input class="sched-input" type="time" value="' + (hh < 10 ? "0" + hh : hh) + ':' + (m < 10 ? "0" + m : m) + '" style="background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:4px 6px;color:var(--fg);font-family:inherit;font-size:11px;flex:none;width:70px" />' +
        '<input class="sched-label" type="text" placeholder="New task..." style="flex:1;background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:4px 8px;color:var(--fg);font-family:inherit;font-size:12px;outline:none" />' +
        '<button class="sched-add" style="padding:4px 10px;border:1px solid var(--copper);border-radius:6px;background:rgba(224,146,92,0.12);color:var(--copper-soft);cursor:pointer;font-size:11px;font-weight:600;font-family:inherit">Add</button>' +
      '</div>';

      var listHTML = '<div style="display:flex;flex-direction:column;gap:6px">';
      scheduledTasks.forEach(function (t, i) {
        var srcColor = t.source === "Jarvis" ? "var(--copper-soft)" : t.source === "Builder" ? "var(--plum)" : t.source === "Sage" ? "var(--sage)" : t.source === "Critic" ? "var(--amber)" : "var(--cyan)";
        listHTML += '<div class="sched-row" data-sched="' + i + '" style="display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--panel)' + (t.done ? ';opacity:0.5' : '') + '">' +
          '<button class="sched-check" data-check="' + i + '" style="width:17px;height:17px;border-radius:50%;border:none;background:' + (t.done ? 'var(--sage)' : 'transparent') + ';cursor:pointer;flex:none;display:grid;place-items:center;color:#1a1206;font-size:10px;box-shadow:inset 0 0 0 1.5px var(--border)">' + (t.done ? '+' : '') + '</button>' +
          '<span style="font-family:JetBrains Mono,monospace;font-size:11px;color:var(--copper-soft);flex:none">' + t.time + '</span>' +
          '<span style="font-size:12px;color:' + (t.done ? 'var(--faint)' : 'var(--fg)') + ';flex:1' + (t.done ? ';text-decoration:line-through' : '') + '>' + t.label + '</span>' +
          '<span style="font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:' + srcColor + ';font-weight:700;flex:none">' + t.source + '</span>' +
          '<button class="sched-del" data-del="' + i + '" style="background:none;border:none;color:var(--faint);cursor:pointer;font-size:14px;padding:0 4px;flex:none">x</button>' +
        '</div>';
      });
      listHTML += '</div>';

      var summary = '<div style="margin-top:12px;font-size:11px;color:var(--faint);text-align:center;font-family:Fraunces,serif;font-style:italic">' +
        scheduledTasks.filter(function (t) { return t.done; }).length + ' of ' + scheduledTasks.length + ' complete</div>';

      content.innerHTML =
        '<div style="font-size:13px;color:var(--copper-soft);font-weight:600;margin-bottom:10px;font-family:Fraunces,serif">Schedule</div>' +
        taskInput + listHTML + summary;

      var addBtn = content.querySelector(".sched-add");
      var timeInput = content.querySelector(".sched-input");
      var labelInput = content.querySelector(".sched-label");

      function saveSchedule() {
        sessionStorage.setItem("vs-schedule", JSON.stringify(scheduledTasks));
      }

      if (addBtn) addBtn.addEventListener("click", function () {
        var time = timeInput.value || "12:00";
        var label = labelInput.value.trim();
        if (!label) return;
        scheduledTasks.push({ time: time, label: label, done: false, source: "You" });
        saveSchedule();
        renderSchedule();
        showToast("Task added: " + label);
      });
      content.querySelectorAll("[data-check]").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          var idx = parseInt(btn.dataset.check);
          scheduledTasks[idx].done = !scheduledTasks[idx].done;
          saveSchedule();
          renderSchedule();
          showToast(scheduledTasks[idx].done ? "Completed: " + scheduledTasks[idx].label : "Unmarked: " + scheduledTasks[idx].label);
        });
      });
      content.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          var idx = parseInt(btn.dataset.del);
          scheduledTasks.splice(idx, 1);
          saveSchedule();
          renderSchedule();
        });
      });
    }

    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        tabs.forEach(function (t) { t.classList.remove("active"); });
        tab.classList.add("active");
        currentTab = tab.dataset.tab;
        renderTab();
      });
    });
    refreshBtn.addEventListener("click", function () {
      showToast("Trace refreshed");
      renderTab();
    });
    renderTab();
  }

  // ============ SKILLS ============
  function initSkills(win) {
    var body = win.querySelector(".dw-body");
    var skills = [
      { name: "code-reviewer", desc: "Review diffs, find gaps, block unclean merges", color: "copper", uses: 142 },
      { name: "scout-scanner", desc: "Scan codebase, identify changes, route to builder", color: "cyan", uses: 98 },
      { name: "research-synth", desc: "Read docs, cite evidence, synthesize findings", color: "sage", uses: 76 },
      { name: "ship-the-build", desc: "Run tests, build, deploy with approve/cancel cards", color: "plum", uses: 211 },
      { name: "voice-summary", desc: "Summarize files via Jarvis voice, hands-free", color: "amber", uses: 54 },
      { name: "context-keeper", desc: "Persist project context across sessions", color: "copper", uses: 187 }
    ];
    body.innerHTML =
      '<div class="dw-skills" style="display:flex;flex-direction:column;height:100%;background:var(--bg-2,#292420);overflow-y:auto;padding:12px">' +
        '<div style="display:flex;gap:8px;margin-bottom:10px">' +
          '<input class="sk-search" type="text" placeholder="Search skills..." style="flex:1;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--fg);font-size:12px;font-family:inherit;outline:none" />' +
          '<button class="sk-new" style="padding:6px 12px;border:1px solid var(--copper);border-radius:8px;background:rgba(224,146,92,0.12);color:var(--copper-soft);cursor:pointer;font-size:11px;font-weight:600;font-family:inherit">+ New</button>' +
        '</div>' +
        '<div class="sk-list" style="display:flex;flex-direction:column;gap:8px;flex:1"></div>' +
      '</div>';
    var list = body.querySelector(".sk-list");
    var search = body.querySelector(".sk-search");
    var newBtn = body.querySelector(".sk-new");

    function colorVar(c) {
      return c === "cyan" ? "var(--cyan)" : c === "plum" ? "var(--plum)" : c === "sage" ? "var(--sage)" : c === "amber" ? "var(--amber)" : "var(--copper-soft)";
    }
    function renderSkills(filter) {
      list.innerHTML = "";
      var filtered = filter ? skills.filter(function (s) { return s.name.indexOf(filter) !== -1 || s.desc.indexOf(filter) !== -1; }) : skills;
      filtered.forEach(function (s) {
        var color = colorVar(s.color);
        var div = document.createElement("div");
        div.className = "sk-card";
        div.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<div style="width:8px;height:8px;border-radius:50%;background:' + color + ';flex:none"></div>' +
            '<span style="font-size:13px;font-weight:600;color:var(--fg)">' + s.name + '</span>' +
            '<span style="font-size:10px;color:var(--faint);margin-left:auto">' + s.uses + ' uses</span>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:4px;line-height:1.4">' + s.desc + '</div>' +
          '<div style="display:flex;gap:6px;margin-top:6px">' +
            '<button class="sk-install" style="padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:var(--panel);color:var(--copper-soft);cursor:pointer;font-size:10px;font-family:inherit">Install</button>' +
            '<button class="sk-run" style="padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:var(--panel);color:var(--muted);cursor:pointer;font-size:10px;font-family:inherit">Run</button>' +
          '</div>';
        var inst = div.querySelector(".sk-install");
        var run = div.querySelector(".sk-run");
        inst.addEventListener("click", function () { showToast("Skill installed: " + s.name); });
        run.addEventListener("click", function () {
          showToast("Running /skills " + s.name + "...");
          setTimeout(function () { showToast("Skill completed: " + s.name); }, 1500);
        });
        list.appendChild(div);
      });
    }
    search.addEventListener("input", function () { renderSkills(search.value.toLowerCase()); });
    newBtn.addEventListener("click", function () {
      showToast("Opening SkillEditor...");
      setTimeout(function () { showToast("SkillEditor: markdown preview ready"); }, 800);
    });
    renderSkills();
  }

  // ============ HIVE ============
  function initHive(win) {
    var body = win.querySelector(".dw-body");
    var stacks = {
      fast: { name: "Fast", steps: [{ model: "Groq Llama", ms: 120, role: "draft" }, { model: "Cerebras", ms: 80, role: "refine" }], total: "200ms" },
      balanced: { name: "Balanced", steps: [{ model: "GPT-4o-mini", ms: 340, role: "draft" }, { model: "Claude Haiku", ms: 520, role: "refine" }], total: "860ms" },
      quality: { name: "Quality", steps: [{ model: "Claude Sonnet", ms: 1200, role: "draft" }, { model: "GPT-4o", ms: 1800, role: "refine" }, { model: "Critic", ms: 400, role: "review" }], total: "3.4s" }
    };
    body.innerHTML =
      '<div class="dw-hive" style="display:flex;flex-direction:column;height:100%;background:var(--bg-2,#292420);overflow-y:auto;padding:12px">' +
        '<div style="display:flex;gap:6px;margin-bottom:12px">' +
          '<button class="hive-tab active" data-stack="fast" style="padding:5px 10px;border-radius:6px;border:1px solid var(--copper);background:rgba(224,146,92,0.12);color:var(--copper-soft);cursor:pointer;font-size:11px;font-weight:600;font-family:inherit">Fast</button>' +
          '<button class="hive-tab" data-stack="balanced" style="padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--panel);color:var(--muted);cursor:pointer;font-size:11px;font-weight:600;font-family:inherit">Balanced</button>' +
          '<button class="hive-tab" data-stack="quality" style="padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--panel);color:var(--muted);cursor:pointer;font-size:11px;font-weight:600;font-family:inherit">Quality</button>' +
        '</div>' +
        '<div class="hive-viz" style="flex:1;display:flex;flex-direction:column;gap:14px"></div>' +
        '<button class="hive-run" style="margin-top:10px;padding:7px;border:1px solid var(--copper);border-radius:8px;background:rgba(224,146,92,0.12);color:var(--copper-soft);cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Run stack</button>' +
      '</div>';
    var viz = body.querySelector(".hive-viz");
    var tabs = body.querySelectorAll(".hive-tab");
    var runBtn = body.querySelector(".hive-run");
    var currentStack = "fast";

    function roleColor(role) {
      return role === "draft" ? "var(--cyan)" : role === "refine" ? "var(--plum)" : "var(--sage)";
    }
    function renderStack(key) {
      var stack = stacks[key];
      viz.innerHTML = "";
      stack.steps.forEach(function (step, i) {
        var color = roleColor(step.role);
        var div = document.createElement("div");
        div.style.cssText = "display:flex;flex-direction:column;gap:4px;opacity:0;transform:translateY(10px);transition:opacity .4s,transform .4s";
        div.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<div style="width:22px;height:22px;border-radius:6px;background:' + color + ';display:grid;place-items:center;color:#1a1206;font-size:10px;font-weight:700;flex:none">' + (i + 1) + '</div>' +
            '<span style="font-size:12px;font-weight:600;color:var(--fg)">' + step.model + '</span>' +
            '<span style="font-size:10px;color:var(--faint);margin-left:auto">/' + step.role + '</span>' +
          '</div>' +
          '<div style="height:6px;background:var(--border);border-radius:99px;overflow:hidden;margin-left:30px">' +
            '<div class="hive-bar" style="height:100%;background:' + color + ';border-radius:99px;width:0;opacity:0;transition:width .8s ' + (i * 0.3) + 's ease,opacity .4s"></div>' +
          '</div>' +
          '<div style="font-size:10px;color:var(--faint);margin-left:30px;font-family:JetBrains Mono,monospace">' + step.ms + 'ms</div>';
        viz.appendChild(div);
        setTimeout(function () { div.style.opacity = "1"; div.style.transform = "none"; }, 50 + i * 100);
      });
      var total = document.createElement("div");
      total.style.cssText = "text-align:center;font-size:13px;color:var(--copper-soft);font-weight:600;font-family:Fraunces,serif;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)";
      total.textContent = "Total: " + stack.total;
      viz.appendChild(total);
    }
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        tabs.forEach(function (t) { t.style.borderColor = "var(--border)"; t.style.color = "var(--muted)"; t.style.background = "var(--panel)"; });
        tab.style.borderColor = "var(--copper)"; tab.style.color = "var(--copper-soft)"; tab.style.background = "rgba(224,146,92,0.12)";
        currentStack = tab.dataset.stack;
        renderStack(currentStack);
      });
    });
    runBtn.addEventListener("click", function () {
      showToast("Running " + stacks[currentStack].name + " stack...");
      var bars = viz.querySelectorAll(".hive-bar");
      bars.forEach(function (bar) { bar.style.width = "0"; bar.style.opacity = "0"; });
      setTimeout(function () {
        var maxMs = Math.max.apply(null, stacks[currentStack].steps.map(function (s) { return s.ms; }));
        bars.forEach(function (bar, i) {
          var ms = stacks[currentStack].steps[i].ms;
          bar.style.width = (ms / maxMs * 100) + "%";
          bar.style.opacity = "1";
        });
        setTimeout(function () { showToast("Synthesized in " + stacks[currentStack].total); }, 1200);
      }, 200);
    });
    renderStack("fast");
  }

  // ============ VIBESPACE WORKSPACE PREVIEW ============
  // A visual, website-only desktop preview. It demonstrates the surrounding
  // operating-system context and simple app switching; it is not a real OS.
  function initWorkspaceClone(host) {
    var state = { shell: "mac", active: "chat", hasReply: false, outsideApp: "" };
    var prompts = {
      chat: ["Plan my next feature", "Review this design", "Turn this into tasks", "Help me ship today"],
      terminals: ["Open a build terminal", "Check the latest logs", "Run a focused test", "Ask a reviewer"],
      agents: ["Choose a teammate", "Start a small task", "Review the plan", "Save the result"],
      files: ["Add project context", "Review recent files", "Find a decision", "Open a source"],
      schedule: ["Plan today", "Make room to focus", "Add a reminder", "Review this week"]
    };

    function esc(value) {
      return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
    }

    function activeLabel() {
      return { chat: "Chat", terminals: "Terminals", agents: "Agents", files: "Files", schedule: "Schedule" }[state.active] || "Chat";
    }

    function launcher(app, icon, label) {
      return '<button type="button" class="vsc-os-launcher' + (app === "workspace" ? " is-workspace" : "") + '" data-vsc-open="' + app + '" aria-label="Open ' + label + '"><i>' + icon + '</i><span>' + label + '</span></button>';
    }

    function externalApp() {
      if (!state.outsideApp) return "";
      var apps = {
        files: {
          title: state.shell === "mac" ? "Finder" : "File Explorer",
          icon: "▤",
          body: '<div class="vsc-external-files"><aside><b>Favorites</b><span>Desktop</span><span>Documents</span><span>Projects</span></aside><div><small>VIBESPACE WEBSITE</small><strong>Recent project files</strong><p><i>MD</i> launch-notes.md <em>Updated now</em></p><p><i>TS</i> workspace.tsx <em>8m ago</em></p><p><i>✦</i> project-context <em>3 linked decisions</em></p></div></div>'
        },
        browser: {
          title: state.shell === "mac" ? "Safari" : "Vibe Browser",
          icon: "◌",
          body: '<div class="vsc-external-browser"><div><button type="button">‹</button><button type="button">›</button><span>vibespaceos.com</span></div><article><small>VIBESPACE</small><strong>One place to think, build, and keep moving.</strong><p>A live preview inside the demo desktop.</p></article></div>'
        },
        terminal: {
          title: state.shell === "mac" ? "Terminal" : "Windows Terminal",
          icon: "›_",
          body: '<div class="vsc-external-terminal"><p><span>vibe@workspace</span>:<b>~</b>$ status</p><p>✓ project context ready</p><p>✓ build notes saved</p><p><span>vibe@workspace</span>:<b>~</b>$ <i>_</i></p></div>'
        },
        notes: {
          title: "Notes",
          icon: "✎",
          body: '<div class="vsc-external-notes"><small>TODAY</small><strong>Homepage pass</strong><p>• make the story feel more like VibeSpace</p><p>• keep the next move clear</p><p>• ship the reviewed version</p></div>'
        }
      };
      var app = apps[state.outsideApp];
      if (!app) return "";
      return '<section class="vsc-external-window vsc-external-window--' + state.outsideApp + '"><header><span><i>' + app.icon + '</i>' + app.title + '</span><button type="button" data-vsc-close-external aria-label="Close ' + app.title + '">×</button></header><div class="vsc-external-body">' + app.body + '</div></section>';
    }

    function desktopChrome() {
      if (state.shell === "windows") {
        return '<div class="vsc-desktop-icons vsc-desktop-icons--windows">' + launcher("workspace", "✦", "VibeSpace") + launcher("files", "▤", "Files") + launcher("browser", "◌", "Browser") + '</div><div class="vsc-windows-taskbar"><button type="button" class="vsc-windows-start">⊞</button>' + launcher("files", "▤", "Files") + launcher("browser", "◌", "Browser") + launcher("terminal", "›_", "Terminal") + launcher("notes", "✎", "Notes") + launcher("workspace", "✦", "VibeSpace") + '<span>12:24</span></div>';
      }
      return '<div class="vsc-mac-menubar"><span class="vsc-mac-apple">●</span><b>VibeSpace</b><span>File</span><span>Edit</span><span>View</span><span>Window</span><em>◌ 12:24</em></div><div class="vsc-desktop-icons">' + launcher("files", "▤", "Finder") + launcher("browser", "◌", "Safari") + '</div><div class="vsc-mac-dock">' + launcher("files", "▤", "Finder") + launcher("browser", "◌", "Safari") + launcher("terminal", "›_", "Terminal") + launcher("notes", "✎", "Notes") + '<b></b>' + launcher("workspace", "✦", "VibeSpace") + '</div>';
    }

    function mainBody() {
      if (state.active === "terminals") {
        return '<div class="vsc-terminal-view"><div class="vsc-terminal-heading"><strong>Terminals</strong><span>10 / 10 panes</span><button type="button" data-vsc-demo="terminal">+ Add pane</button></div><div class="vsc-terminal-grid">' + ["Builder", "Critic", "Coder", "Scout"].map(function (name, index) { return '<div class="vsc-terminal-card"><div><i class="vsc-agent-dot a' + index + '"></i><strong>' + name + '</strong><small>PowerShell</small></div><p>PS C:\\Users\\viper&gt; <b>' + (index === 1 ? 'checking build…' : '_') + '</b></p></div>'; }).join("") + '</div></div>';
      }
      if (state.active === "agents") {
        return '<div class="vsc-agents-view"><span>TEAM ROOM</span><h3>Pick the right teammate for the next move.</h3><div class="vsc-agent-list"><button type="button" data-vsc-demo="agent"><i class="vsc-agent-dot jarvis"></i><div><strong>Jarvis</strong><small>Keeps the project moving</small></div><b>Ready</b></button><button type="button" data-vsc-demo="agent"><i class="vsc-agent-dot coder"></i><div><strong>Coder</strong><small>Builds the focused change</small></div><b>Ready</b></button><button type="button" data-vsc-demo="agent"><i class="vsc-agent-dot critic"></i><div><strong>Critic</strong><small>Checks the details before you ship</small></div><b>Ready</b></button></div></div>';
      }
      if (state.active === "files") {
        return '<div class="vsc-files-view"><span>PROJECT CONTEXT</span><h3>The important stuff stays close.</h3><div class="vsc-file-stack"><div><i>MD</i><strong>launch-notes.md</strong><small>Updated now</small></div><div><i>TS</i><strong>workspace.tsx</strong><small>Edited 8m ago</small></div><div><i>✦</i><strong>project-context</strong><small>3 linked decisions</small></div></div></div>';
      }
      if (state.active === "schedule") {
        return '<div class="vsc-schedule-view"><span>TODAY</span><h3>Keep the next step obvious.</h3><div><p><b>11:00</b> Finish the homepage pass</p><p><b>2:30</b> Check the build and notes</p><p><b>4:00</b> Ship the reviewed version</p></div></div>';
      }
      return '<div class="vsc-chat-view"><div class="vsc-chat-empty"><i>✦</i><h3>' + (state.hasReply ? 'That sounds like a good place to start.' : 'What are you building today?') + '</h3><p>' + (state.hasReply ? 'Jarvis turned your idea into a clear first move. Keep the rest of the project here as it grows.' : 'Start with a thought, a file, or a messy idea. VibeSpace keeps the useful context with it.') + '</p></div><div class="vsc-prompt-row">' + prompts.chat.map(function (prompt) { return '<button type="button" data-vsc-prompt="' + esc(prompt) + '">' + esc(prompt) + '</button>'; }).join("") + '</div></div>';
    }

    function render() {
      host.dataset.vsShell = state.shell;
      host.innerHTML = [
        '<div class="vsc-os vsc-os--' + state.shell + '">',
          desktopChrome(),
          '<section class="vsc-app-window vsc-vibespace-window">',
            '<div class="vsc-shell">',
              '<div class="vsc-titlebar"><div class="vsc-window-controls"><i></i><i></i><i></i></div><div class="vsc-crumb"><b>▣</b><strong>Workspace</strong><span>/</span><strong>Project</strong><span>/</span><em>' + activeLabel() + '</em></div><div class="vsc-top-actions"><button type="button" aria-label="Search">⌕</button><button type="button" aria-label="Voice">◌</button><button type="button" data-vsc-settings aria-label="Open preferences">⚙</button><i>J</i></div></div>',
              '<div class="vsc-content">',
                '<aside class="vsc-sidebar"><div class="vsc-side-label">WORKSPACE</div><nav>',
                  '<button data-vsc-nav="chat"><i>▱</i>Chat</button><button data-vsc-nav="terminals"><i>›_</i>Terminals</button><button data-vsc-nav="agents"><i>✦</i>Agents</button><button data-vsc-nav="schedule"><i>◫</i>Schedule</button><button data-vsc-nav="files"><i>▤</i>Files</button>',
                '</nav><div class="vsc-side-group"><span>PROJECTS <b>+</b></span><button class="vsc-project"><i></i>VibeSpace website</button></div><div class="vsc-side-group"><span>CHATS <b>+</b></span><button class="vsc-chat-name">▱ New chat 1</button></div><div class="vsc-side-group vsc-side-agents"><span>AGENTS <b>+</b></span><button><i class="vsc-agent-dot jarvis"></i>Jarvis</button><button><i class="vsc-agent-dot coder"></i>Coder</button></div></aside>',
                '<main class="vsc-main"><div class="vsc-mainbar"><span>New chat 1 <b>×</b></span><button type="button" data-vsc-demo="new">＋</button></div><div class="vsc-canvas">' + mainBody() + '</div><form class="vsc-composer"><div><input aria-label="Message Jarvis" placeholder="Message Jarvis… (use @ to mention an agent)" /><span>Choose model⌄</span><b>Agent Mode</b></div><button type="submit">↗</button></form></main>',
              '</div>',
              '<div class="vsc-settings" hidden><div class="vsc-settings-head"><strong>Preferences</strong><button type="button" data-vsc-close>×</button></div><label><span>Appearance</span><b>Dark</b></label><div class="vsc-settings-shell"><span>Desktop style</span><div><button type="button" data-vsc-shell="mac">Mac</button><button type="button" data-vsc-shell="windows">Windows</button></div></div><small>Switches this demo desktop. VibeSpace keeps running underneath.</small></div>',
            '</div>',
          '</section>',
          externalApp(),
        '</div>'
      ].join("");
      host.classList.add("is-clone-ready");

      host.querySelectorAll("[data-vsc-nav]").forEach(function (button) {
        var selected = button.dataset.vscNav === state.active;
        button.classList.toggle("is-active", selected);
        button.addEventListener("click", function () { state.active = button.dataset.vscNav; state.hasReply = false; render(); });
      });
      host.querySelectorAll("[data-vsc-prompt]").forEach(function (button) {
        button.addEventListener("click", function () { state.hasReply = true; render(); });
      });
      host.querySelectorAll("[data-vsc-demo]").forEach(function (button) {
        button.addEventListener("click", function () { state.hasReply = true; state.active = "chat"; render(); });
      });
      host.querySelectorAll("[data-vsc-open]").forEach(function (button) {
        button.addEventListener("click", function () {
          state.outsideApp = button.dataset.vscOpen === "workspace" ? "" : button.dataset.vscOpen;
          render();
        });
      });
      var closeExternal = host.querySelector("[data-vsc-close-external]");
      if (closeExternal) closeExternal.addEventListener("click", function () { state.outsideApp = ""; render(); });
      var form = host.querySelector(".vsc-composer");
      form.addEventListener("submit", function (event) { event.preventDefault(); state.hasReply = true; state.active = "chat"; render(); });
      var settingsButton = host.querySelector("[data-vsc-settings]");
      var settings = host.querySelector(".vsc-settings");
      settingsButton.addEventListener("click", function () { settings.hidden = false; });
      host.querySelector("[data-vsc-close]").addEventListener("click", function () { settings.hidden = true; });
      host.querySelectorAll("[data-vsc-shell]").forEach(function (button) {
        var selected = button.dataset.vscShell === state.shell;
        button.classList.toggle("is-active", selected);
        button.addEventListener("click", function () { state.shell = button.dataset.vscShell; render(); });
      });
    }
    render();
  }

  // Boot
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
