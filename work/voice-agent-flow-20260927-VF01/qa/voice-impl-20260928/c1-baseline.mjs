import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';
import {
  captureOfficialIdentity,
  probeOfficialPage,
  readWindowsNativeState,
} from '../../../../scripts/pr31-native-acceptance-harness.mjs';

const EXPECTED = Object.freeze({
  port: 9223,
  jarvisPid: 19476,
  executablePath: 'D:\\VibeSpace-Testing\\MI01-cargo-target\\debug\\jarvis.exe',
  profile: 'C:\\Users\\viper\\AppData\\Local\\ai.jarvis.desktop\\EBWebView',
  origin: 'http://localhost:5173',
});

function parseArgs(argv) {
  const values = new Map();
  for (let i = 2; i < argv.length; i += 2) values.set(argv[i], argv[i + 1]);
  const config = {
    port: Number(values.get('--port')),
    jarvisPid: Number(values.get('--jarvis-pid')),
    executablePath: values.get('--exe'),
    profile: values.get('--profile'),
    targetUrl: values.get('--url'),
  };
  if (
    config.port !== EXPECTED.port ||
    config.jarvisPid !== EXPECTED.jarvisPid ||
    config.executablePath !== EXPECTED.executablePath ||
    config.profile !== EXPECTED.profile ||
    config.targetUrl !== 'http://localhost:5173/?route=chat'
  ) {
    throw new Error('C1 identity arguments must exactly match the current reservation.');
  }
  return config;
}

function normalize(value) {
  return String(value ?? '').replaceAll('/', '\\').toLowerCase();
}

function sameIdentity(left, right) {
  return (
    left.jarvisPid === right.jarvisPid &&
    left.webViewPid === right.webViewPid &&
    normalize(left.executablePath) === normalize(right.executablePath) &&
    normalize(left.profile) === normalize(right.profile) &&
    left.cdpPort === right.cdpPort &&
    left.listenerAddress === right.listenerAddress
  );
}

function asPublicIdentity(identity) {
  return {
    jarvisPid: identity.jarvisPid,
    webViewPid: identity.webViewPid,
    executablePath: identity.executablePath,
    profile: identity.profile,
    cdpPort: identity.cdpPort,
    listenerAddress: identity.listenerAddress,
    capturedAt: identity.capturedAt,
  };
}

async function snapshot(page, proof, identity, readyMs) {
  const state = await page.evaluate(async () => {
    const [authModule, uiModule, voiceModule] = await Promise.all([
      import('/src/stores/auth.ts'),
      import('/src/stores/ui.ts'),
      import('/src/features/voice/store.ts'),
    ]);
    const auth = authModule.useAuthStore.getState();
    const ui = uiModule.useUIStore.getState();
    const voice = voiceModule.useVoiceStore.getState();
    let microphonePermission = 'unavailable';
    try {
      if (navigator.permissions?.query) {
        microphonePermission = (await navigator.permissions.query({ name: 'microphone' })).state;
      }
    } catch {
      microphonePermission = 'unsupported';
    }
    const deepgramOptionStored = (() => {
      try {
        return window.localStorage.getItem('vibespace.deepgram.stt-option.v1');
      } catch {
        return null;
      }
    })();
    const panel = document.querySelector('#jarvis-panel');
    const bounds = panel?.getBoundingClientRect();
    const panelVisible = Boolean(
      panel &&
        bounds &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        getComputedStyle(panel).visibility !== 'hidden' &&
        getComputedStyle(panel).display !== 'none',
    );
    return {
      storeHydrated: authModule.useAuthStore.persist?.hasHydrated?.() ?? null,
      voiceModalOpen: Boolean(ui.voiceModalOpen),
      voicePanelMounted: Boolean(panel),
      voicePanelVisible: panelVisible,
      voiceState: voice.state,
      voiceErrorPresent: Boolean(voice.errorMessage),
      voiceSessionPresent: Boolean(voice.session),
      settings: {
        mainAgentProvider: auth.voiceMainAgentProvider,
        workerProvider: auth.voiceWorkerProvider,
        workerSessionMode: auth.voiceWorkerSessionMode,
        sttProvider: auth.composerSttProvider,
        deepgramModelOptionStored: deepgramOptionStored,
        fasterWhisperModel: auth.fasterWhisperModel,
        ttsEngine: auth.voiceEngine,
        ttsVoicePreset: auth.voicePreset,
        speakReplies: Boolean(auth.speakReplies),
        handsFreeOnOpen: Boolean(auth.voiceAutoListenOnOpen),
      },
      audioApiFeasibility: {
        secureContext: Boolean(window.isSecureContext),
        mediaDevicesAvailable: Boolean(navigator.mediaDevices),
        getUserMediaAvailable: typeof navigator.mediaDevices?.getUserMedia === 'function',
        microphonePermission,
        speechRecognitionAvailable:
          typeof window.SpeechRecognition === 'function' ||
          typeof window.webkitSpeechRecognition === 'function',
        speechSynthesisAvailable: typeof window.speechSynthesis !== 'undefined',
        installedSpeechVoiceCount:
          typeof window.speechSynthesis !== 'undefined'
            ? window.speechSynthesis.getVoices().length
            : 0,
        wavAudioElementSupported: Boolean(document.createElement('audio').canPlayType('audio/wav')),
      },
    };
  });
  return {
    capturedAt: new Date().toISOString(),
    mode: 'read-only baseline; no click, screenshot, transcript/draft read, mic request, or playback',
    identity: asPublicIdentity(identity),
    page: {
      url: page.url(),
      title: await page.title(),
      ready: proof.ready,
      documentReadyState: proof.readyState,
      hasTauriBridge: proof.hasTauri,
      attachAndReadyMs: readyMs,
      officialPageCount: proof.officialPageCount,
    },
    ...state,
  };
}

async function main() {
  const config = parseArgs(process.argv);
  const startedAt = performance.now();
  const before = captureOfficialIdentity(await readWindowsNativeState(), {
    expectedExecutablePath: config.executablePath,
    expectedProfile: config.profile,
    localAppData: 'C:\\Users\\viper\\AppData\\Local',
    cdpPort: config.port,
    jarvisPid: config.jarvisPid,
  });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + config.port, {
    timeout: 10_000,
  });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const officialPages = [];
  for (const page of pages) {
    const result = await probeOfficialPage(page);
    if (result.ready) officialPages.push({ page, proof: result });
  }
  const targetPages = officialPages.filter(({ page }) => {
    const url = new URL(page.url());
    return (
      url.origin === EXPECTED.origin &&
      url.pathname === '/' &&
      url.searchParams.get('route') === 'chat'
    );
  });
  if (targetPages.length !== 1) {
    throw new Error(
      'Expected exactly one attested official C1 chat page; found ' + targetPages.length + '.',
    );
  }
  const selected = targetPages[0];
  const after = captureOfficialIdentity(await readWindowsNativeState(), {
    expectedExecutablePath: config.executablePath,
    expectedProfile: config.profile,
    localAppData: 'C:\\Users\\viper\\AppData\\Local',
    cdpPort: config.port,
    jarvisPid: config.jarvisPid,
  });
  if (!sameIdentity(before, after)) throw new Error('C1 identity changed during attach.');
  selected.proof.officialPageCount = officialPages.length;
  const readyMs = Math.round(performance.now() - startedAt);
  const initial = await snapshot(selected.page, selected.proof, after, readyMs);
  process.stdout.write(JSON.stringify(initial, null, 2) + '\n');
  process.stdout.write('Commands: snapshot (read-only refresh), quit (disconnect this driver only).\n');

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', async (line) => {
    const command = line.trim().toLowerCase();
    if (command === 'quit') {
      process.stdout.write('Driver exiting; no native process or app window will be closed.\n');
      process.exit(0);
    }
    if (command === 'snapshot') {
      try {
        const current = captureOfficialIdentity(await readWindowsNativeState(), {
          expectedExecutablePath: config.executablePath,
          expectedProfile: config.profile,
          localAppData: 'C:\\Users\\viper\\AppData\\Local',
          cdpPort: config.port,
          jarvisPid: config.jarvisPid,
        });
        if (!sameIdentity(after, current)) throw new Error('C1 identity changed; refusing to inspect.');
        process.stdout.write(JSON.stringify(await snapshot(selected.page, selected.proof, current, readyMs), null, 2) + '\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }) + '\n');
      }
    }
  });
}

main().catch((error) => {
  process.stderr.write('C1_BASELINE_FAILED: ' + String(error?.message ?? error) + '\n');
  process.exitCode = 1;
});
