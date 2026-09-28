import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const EXPECTED = Object.freeze({
  port: 9223,
  jarvisPid: 19476,
  executablePath: 'D:\\VibeSpace-Testing\\MI01-cargo-target\\debug\\jarvis.exe',
  profile: 'C:\\Users\\viper\\AppData\\Local\\ai.jarvis.desktop\\EBWebView',
  targetUrl: 'http://localhost:5173/?route=chat',
});

function parseArgs(argv) {
  const args = new Map();
  for (let i = 2; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);
  const config = {
    port: Number(args.get('--port')),
    jarvisPid: Number(args.get('--jarvis-pid')),
    executablePath: args.get('--exe'),
    profile: args.get('--profile'),
    targetUrl: args.get('--url'),
  };
  if (Object.keys(EXPECTED).some((key) => config[key] !== EXPECTED[key])) {
    throw new Error('C1 arguments do not match the reserved identity.');
  }
  return config;
}

function normalized(value) {
  return String(value ?? '').replaceAll('/', '\\').toLowerCase();
}

function sameIdentity(a, b) {
  return a.jarvisPid === b.jarvisPid && a.webViewPid === b.webViewPid &&
    normalized(a.executablePath) === normalized(b.executablePath) &&
    normalized(a.profile) === normalized(b.profile) && a.cdpPort === b.cdpPort &&
    a.listenerAddress === b.listenerAddress;
}

async function loadHarness() {
  const file = path.resolve(process.cwd(), 'scripts', 'pr31-native-acceptance-harness.mjs');
  return import(pathToFileURL(file).href);
}

async function snapshot(page) {
  const state = await page.evaluate(async () => {
    const [authModule, uiModule, voiceModule] = await Promise.all([
      import('/src/stores/auth.ts'), import('/src/stores/ui.ts'), import('/src/features/voice/store.ts'),
    ]);
    const auth = authModule.useAuthStore.getState();
    const ui = uiModule.useUIStore.getState();
    const voice = voiceModule.useVoiceStore.getState();
    const panel = document.querySelector('#jarvis-panel');
    const box = panel?.getBoundingClientRect();
    const status = panel?.querySelector('[role="status"]')?.textContent?.trim() ?? null;
    let microphonePermission = 'unavailable';
    try {
      if (navigator.permissions?.query) microphonePermission = (await navigator.permissions.query({ name: 'microphone' })).state;
    } catch { microphonePermission = 'unsupported'; }
    const errorText = String(voice.errorMessage ?? '').toLowerCase();
    const errorCategory = !errorText ? null : /permission|denied|notallowed/.test(errorText) ? 'permission' :
      /device|microphone|media/.test(errorText) ? 'capture' : /stt|transcrib|speech/.test(errorText) ? 'stt' : 'other';
    return {
      voiceModalOpen: Boolean(ui.voiceModalOpen),
      panelVisible: Boolean(panel && box && box.width > 0 && box.height > 0 && getComputedStyle(panel).visibility !== 'hidden' && getComputedStyle(panel).display !== 'none'),
      voiceState: voice.state,
      voiceErrorPresent: Boolean(voice.errorMessage),
      voiceErrorCategory: errorCategory,
      sessionPresent: Boolean(voice.session),
      statusLabel: status,
      settings: {
        mainAgentProvider: auth.voiceMainAgentProvider,
        workerProvider: auth.voiceWorkerProvider,
        workerSessionMode: auth.voiceWorkerSessionMode,
        sttProvider: auth.composerSttProvider,
        deepgramModelOptionStored: (() => { try { return localStorage.getItem('vibespace.deepgram.stt-option.v1'); } catch { return null; } })(),
        ttsEngine: auth.voiceEngine,
        ttsVoicePreset: auth.voicePreset,
        speakReplies: Boolean(auth.speakReplies),
        handsFreeOnOpen: Boolean(auth.voiceAutoListenOnOpen),
      },
      audio: {
        getUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
        microphonePermission,
        speechRecognition: typeof window.SpeechRecognition === 'function' || typeof window.webkitSpeechRecognition === 'function',
        speechSynthesis: typeof window.speechSynthesis !== 'undefined',
        speechVoiceCount: typeof window.speechSynthesis !== 'undefined' ? window.speechSynthesis.getVoices().length : 0,
        wavPlayback: Boolean(document.createElement('audio').canPlayType('audio/wav')),
      },
      // This receipt deliberately never reads transcript content, drafts, message bodies, or chat IDs.
    };
  });
  return { capturedAt: new Date().toISOString(), url: page.url(), title: await page.title(), ...state };
}

async function diagnoseVoiceOpenButton(page) {
  const button = page.getByRole('button', { name: 'Start Jarvis voice', exact: true });
  const count = await button.count();
  if (count !== 1) return { count, actionable: false, reason: 'missing_or_ambiguous' };
  const visible = await button.isVisible();
  const enabled = await button.isEnabled();
  const hit = await button.evaluate((el) => {
    const rectOf = (node) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
    };
    const safeAttrs = (node) => Array.from(node?.attributes ?? [])
      .filter((a) => ['id', 'class', 'role', 'aria-label', 'aria-modal', 'aria-hidden', 'aria-expanded', 'data-state', 'data-testid', 'data-sik-evidence'].includes(a.name) ||
        (a.name.startsWith('data-') && !/(token|secret|password|credential|authorization|api.?key|prompt|text|message|chat|user|account|project|session|(?:^|-)id$)/i.test(a.name)))
      .map((a) => {
        const riskyName = /(token|secret|password|credential|authorization|api.?key|prompt|text|message|chat|user|account|project|session|(?:^|-)id$)/i.test(a.name) && a.name.startsWith('data-');
        const riskyValue = /(bearer\\s|sk-(?:proj-|live-|test-)?[a-z0-9_-]{12,}|eyJ[a-z0-9_-]{8,}\\.[a-z0-9_-]{8,}\\.)/i.test(a.value);
        return { name: a.name, value: riskyName || riskyValue ? '[redacted]' : String(a.value).slice(0, 100) };
      });
    const describe = (node) => {
      if (!node) return null;
      const attrs = safeAttrs(node);
      const openingTag = '<' + node.tagName.toLowerCase() + attrs.map((a) => ' ' + a.name + '="' + a.value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '"').join('') + '>';
      const css = getComputedStyle(node);
      return {
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        className: typeof node.className === 'string' ? node.className.slice(0, 180) : null,
        role: node.getAttribute('role'),
        dataAttributeNames: Array.from(node.attributes).map((a) => a.name).filter((name) => name.startsWith('data-')),
        dataAttributes: attrs.filter((a) => a.name.startsWith('data-')),
        outerHTMLOpeningTagPrefix: openingTag.slice(0, 900),
        rect: rectOf(node),
        computed: { pointerEvents: css.pointerEvents, zIndex: css.zIndex, position: css.position, display: css.display, visibility: css.visibility, opacity: css.opacity, transform: css.transform, isolation: css.isolation, contain: css.contain, willChange: css.willChange },
      };
    };
    const r = el.getBoundingClientRect();
    const point = { x: Math.round((r.left + r.width / 2) * 10) / 10, y: Math.round((r.top + r.height / 2) * 10) / 10 };
    const top = document.elementFromPoint(point.x, point.y);
    let ancestor = top?.parentElement ?? null;
    let nearestStackingAncestor = null;
    for (let depth = 0; ancestor && depth < 12; depth++, ancestor = ancestor.parentElement) {
      const s = getComputedStyle(ancestor);
      const stacking = (s.position !== 'static' && s.zIndex !== 'auto') || Number(s.opacity) < 1 || s.transform !== 'none' || s.filter !== 'none' || s.isolation === 'isolate' || s.contain.includes('paint') || s.willChange.split(',').some((v) => ['transform', 'opacity', 'filter'].includes(v.trim()));
      if (stacking) { nearestStackingAncestor = { depth: depth + 1, ...describe(ancestor) }; break; }
    }
    const css = getComputedStyle(el);
    return {
      point,
      buttonRect: rectOf(el),
      centerInsideViewport: point.x >= 0 && point.y >= 0 && point.x <= innerWidth && point.y <= innerHeight,
      centerHitIsButtonOrChild: Boolean(top && (top === el || el.contains(top))),
      hitTarget: describe(top),
      nearestStackingAncestor,
      buttonComputed: { pointerEvents: css.pointerEvents, zIndex: css.zIndex, position: css.position, display: css.display, visibility: css.visibility, opacity: css.opacity },
      modalCount: document.querySelectorAll('[aria-modal="true"]').length,
    };
  });
  const actionable = visible && enabled && hit.buttonRect?.width > 0 && hit.buttonRect?.height > 0 &&
    hit.centerInsideViewport && hit.centerHitIsButtonOrChild &&
    hit.buttonComputed.pointerEvents !== 'none' && hit.buttonComputed.display !== 'none' &&
    hit.buttonComputed.visibility !== 'hidden' && Number(hit.buttonComputed.opacity) > 0 && hit.modalCount === 0;
  return { count, visible, enabled, hit, actionable, reason: actionable ? 'topmost_button_verified' : 'button_not_actionable' };
}
async function main() {
  const config = parseArgs(process.argv);
  const harness = await loadHarness();
  const attestOptions = {
    expectedExecutablePath: config.executablePath,
    expectedProfile: config.profile,
    localAppData: 'C:\\Users\\viper\\AppData\\Local',
    cdpPort: config.port,
    jarvisPid: config.jarvisPid,
  };
  const before = harness.captureOfficialIdentity(await harness.readWindowsNativeState(), attestOptions);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + config.port, { timeout: 10_000 });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const readyPages = [];
  for (const page of pages) {
    const proof = await harness.probeOfficialPage(page);
    if (proof.ready) readyPages.push({ page, proof });
  }
  const matches = readyPages.filter(({ page }) => {
    const url = new URL(page.url());
    return url.origin + url.pathname + url.search === config.targetUrl;
  });
  if (matches.length !== 1) throw new Error('Expected exactly one attested C1 chat page; found ' + matches.length + '.');
  const { page, proof } = matches[0];
  const after = harness.captureOfficialIdentity(await harness.readWindowsNativeState(), attestOptions);
  if (!sameIdentity(before, after)) throw new Error('C1 identity changed during attach.');
  const ensureIdentity = async () => {
    const current = harness.captureOfficialIdentity(await harness.readWindowsNativeState(), attestOptions);
    if (!sameIdentity(after, current)) throw new Error('C1 identity changed; refusing further control.');
    return current;
  };
  process.stdout.write(JSON.stringify({
    event: 'attached', capturedAt: new Date().toISOString(), identity: {
      jarvisPid: after.jarvisPid, webViewPid: after.webViewPid, executablePath: after.executablePath,
      profile: after.profile, cdpPort: after.cdpPort, listenerAddress: after.listenerAddress,
    },
    page: { url: page.url(), ready: proof.ready, readyState: proof.readyState, hasTauriBridge: proof.hasTauri, attestedOfficialPages: readyPages.length },
    snapshot: await snapshot(page),
  }, null, 2) + '\n');
  process.stdout.write('Commands: wake (one Escape key to dismiss ambient mode), open (one bounded normal voice-open attempt; stops capture promptly), state, close, quit.\n');

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', async (line) => {
    const command = line.trim().toLowerCase();
    try {
      if (command === 'quit') {
        process.stdout.write('Driver exiting; native app/window remains open.\n');
        process.exit(0);
      }
      if (command === 'state') {
        const current = await ensureIdentity();
        process.stdout.write(JSON.stringify({ event: 'state', snapshot: await snapshot(page) }, null, 2) + '\n');
      } else if (command === 'diagnose') {
        await ensureIdentity();
        const diagnostic = await diagnoseVoiceOpenButton(page);
        process.stdout.write(JSON.stringify({ event: 'voice_open_diagnostic', diagnostic, capturedAt: new Date().toISOString() }, null, 2) + '\n');
      } else if (command === 'wake') {
        await ensureIdentity();
        const ambient = page.locator('[data-monochrome-surface="ambient-home"]');
        if (!(await ambient.isVisible().catch(() => false))) throw new Error('Ambient home is not visibly active; no key sent.');
        const beforeWake = await ambient.evaluate((el) => ({
          visible: getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden',
          role: el.getAttribute('role'), label: el.getAttribute('aria-label'), state: el.getAttribute('data-state'),
        }));
        if (!beforeWake.visible || beforeWake.role !== 'dialog' || !/press any key to wake/i.test(beforeWake.label ?? '')) {
          throw new Error('Ambient wake screen did not match the verified harmless-key target.');
        }
        const started = performance.now();
        await page.keyboard.press('Escape');
        await ambient.waitFor({ state: 'hidden', timeout: 3000 });
        await page.waitForTimeout(100);
        const overlayInactive = !(await ambient.isVisible().catch(() => false));
        if (!overlayInactive) throw new Error('Ambient overlay remained visible after the single Escape key.');
        const afterWakeIdentity = await ensureIdentity();
        const diagnostic = await diagnoseVoiceOpenButton(page);
        process.stdout.write(JSON.stringify({
          event: 'ambient_wake', key: 'Escape', wakeMs: Math.round(performance.now() - started),
          beforeWake, overlayInactive, voiceControlActionable: diagnostic.actionable,
          diagnostic, identity: { jarvisPid: afterWakeIdentity.jarvisPid, webViewPid: afterWakeIdentity.webViewPid, cdpPort: afterWakeIdentity.cdpPort },
          capturedAt: new Date().toISOString(),
        }, null, 2) + '\n');
      } else if (command === 'open') {
        await ensureIdentity();
        const initial = await snapshot(page);
        if (initial.voiceModalOpen) throw new Error('Voice modal is already open; no second toggle sent.');
        const ambient = page.locator('[data-monochrome-surface="ambient-home"]');
        if (await ambient.isVisible().catch(() => false)) throw new Error('Ambient home is still active; no voice click sent.');
        const button = page.getByRole('button', { name: 'Start Jarvis voice', exact: true });
        const diagnostic = await diagnoseVoiceOpenButton(page);
        if (!diagnostic.actionable) throw new Error('Voice-open control blocked by bounded hit-target diagnosis: ' + JSON.stringify(diagnostic));
        const start = performance.now();
        await button.click({ timeout: 3000 });
        await page.locator('#jarvis-panel').waitFor({ state: 'visible', timeout: 8000 });
        const openMs = Math.round(performance.now() - start);
        await page.waitForTimeout(350);
        const opened = await snapshot(page);
        let captureStopped = false;
        if (opened.voiceState === 'listening') {
          const stop = page.getByRole('button', { name: 'Stop listening', exact: true });
          if (await stop.count() === 1) { await stop.click({ timeout: 2000 }); captureStopped = true; }
        } else if (opened.voiceState === 'thinking' || opened.voiceState === 'speaking') {
          const stop = page.getByRole('button', { name: 'Stop response', exact: true });
          if (await stop.count() === 1) { await stop.click({ timeout: 2000 }); captureStopped = true; }
        } else {
          const cancel = page.getByRole('button', { name: 'Cancel microphone request', exact: true });
          if (await cancel.count() === 1) { await cancel.click({ timeout: 2000 }); captureStopped = true; }
        }
        await ensureIdentity();
        process.stdout.write(JSON.stringify({ event: 'voice_open', openMs, diagnostic, opened, captureStopped, afterControl: await snapshot(page), capturedAt: new Date().toISOString() }, null, 2) + '\n');
      } else if (command === 'cleanup') {
        await ensureIdentity();
        const cleanup = await page.evaluate(async () => {
          const [uiModule, routerModule, voiceServiceModule] = await Promise.all([
            import('/src/stores/ui.ts'), import('/src/features/voice/voiceRouter.ts'), import('/src/features/voice/JarvisVoiceInputService.ts'),
          ]);
          const voiceService = voiceServiceModule.JarvisVoiceInputService;
          const before = { active: voiceService.isListening(), wantsListening: voiceService.wantsListening() };
          uiModule.useUIStore.getState().setVoiceModalOpen(false);
          voiceService.cancelListening();
          routerModule.handleVoiceModuleClosed();
          await new Promise((resolve) => window.setTimeout(resolve, 400));
          return { before, after: { active: voiceService.isListening(), wantsListening: voiceService.wantsListening() } };
        });
        await ensureIdentity();
        process.stdout.write(JSON.stringify({ event: 'voice_safety_cleanup', ...cleanup, snapshot: await snapshot(page), capturedAt: new Date().toISOString() }, null, 2) + '\n');
      } else if (command === 'close') {
        await ensureIdentity();
        const close = page.getByRole('button', { name: 'Close Jarvis voice session', exact: true });
        if (await close.count() === 1 && await close.isVisible()) await close.click({ timeout: 3000 });
        await page.locator('#jarvis-panel').waitFor({ state: 'detached', timeout: 5000 });
        await ensureIdentity();
        process.stdout.write(JSON.stringify({ event: 'voice_closed', snapshot: await snapshot(page), capturedAt: new Date().toISOString() }, null, 2) + '\n');
      } else {
        process.stdout.write(JSON.stringify({ error: 'unknown_command' }) + '\n');
      }
    } catch (error) {
      process.stdout.write(JSON.stringify({ event: 'command_failed', command, error: String(error?.message ?? error).slice(0, 240), snapshot: await snapshot(page).catch(() => null), capturedAt: new Date().toISOString() }, null, 2) + '\n');
    }
  });
}

main().catch((error) => {
  process.stderr.write('C1_VOICE_DRIVER_FAILED: ' + String(error?.message ?? error).slice(0, 300) + '\n');
  process.exitCode = 1;
});
