import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  captureOfficialIdentity,
  probeOfficialPage,
  readWindowsNativeState,
  selectStableOfficialPage,
} from '../../../../../scripts/pr31-native-acceptance-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
const OUT = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED = Object.freeze({
  port: 9252,
  jarvisPid: 17280,
  executablePath:
    'C:\\Users\\viper\\VibeSpace-UnifiedChungus-Final\\work\\dual-live-20260912\\target-c2\\debug\\jarvis.exe',
  profile:
    'C:\\Users\\viper\\VibeSpace-UnifiedChungus-Final\\work\\dual-live-20260912\\profile-c2\\EBWebView',
  origin: 'http://localhost:5173',
  route: 'chat',
});
const SOURCE_FILES = [
  'app/src/features/voice/VoiceModal.tsx',
  'app/src/features/voice/voiceRouter.ts',
  'app/src/features/voice/JarvisVoiceInputService.ts',
];

function parseArgs(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  const actual = {
    port: Number(values.get('--port')),
    jarvisPid: Number(values.get('--jarvis-pid')),
    executablePath: values.get('--exe'),
    profile: values.get('--profile'),
    origin: values.get('--origin'),
    route: values.get('--route'),
  };
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
    throw new Error('VNA02 arguments must match the active C2 reservation.');
  }
  return actual;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function identityOptions(config) {
  return {
    expectedExecutablePath: config.executablePath,
    expectedProfile: config.profile,
    localAppData: 'C:\\Users\\viper\\AppData\\Local',
    cdpPort: config.port,
    jarvisPid: config.jarvisPid,
  };
}

function captureViteIdentity(rawState) {
  const process = (rawState.processes ?? []).find(
    (item) => Number(item.ProcessId ?? item.processId ?? item.pid) === 32892,
  );
  const listener = (rawState.listeners ?? []).find(
    (item) =>
      Number(item.LocalPort ?? item.localPort) === 5173 &&
      Number(item.OwningProcess ?? item.owningProcess) === 32892,
  );
  const commandLine = String(process?.CommandLine ?? process?.commandLine ?? '')
    .toLowerCase()
    .replaceAll('/', '\\');
  const executablePath = String(process?.ExecutablePath ?? process?.executablePath ?? '');
  const processId = Number(process?.ProcessId ?? process?.processId ?? process?.pid);
  const listenerAddress = String(listener?.LocalAddress ?? listener?.localAddress ?? '');
  const listenerPort = Number(listener?.LocalPort ?? listener?.localPort);
  if (
    !process ||
    !listener ||
    !executablePath.toLowerCase().endsWith('\\node.exe') ||
    !commandLine.includes('\\app\\node_modules') ||
    !commandLine.includes('vite.js')
  ) {
    throw new Error('repo_vite_renderer_identity_mismatch');
  }
  return {
    processId,
    listenerAddress,
    listenerPort,
    executablePath,
    commandIsRepoVite: true,
  };
}

async function visiblePanel(page) {
  return page.evaluate(() => {
    const element = document.querySelector('#jarvis-panel');
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  });
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const [uiModule, voiceModule, inputModule] = await Promise.all([
      import('/src/stores/ui.ts'),
      import('/src/features/voice/store.ts'),
      import('/src/features/voice/JarvisVoiceInputService.ts'),
    ]);
    const ui = uiModule.useUIStore.getState();
    const voice = voiceModule.useVoiceStore.getState();
    const input = inputModule.JarvisVoiceInputService;
    const ambient = document.querySelector('[data-monochrome-surface="ambient-home"]');
    const ambientRect = ambient?.getBoundingClientRect();
    const ambientStyle = ambient ? getComputedStyle(ambient) : null;
    const panel = document.querySelector('#jarvis-panel');
    const panelRect = panel?.getBoundingClientRect();
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const currentUrl = new URL(window.location.href);
    return {
      capturedAt: new Date().toISOString(),
      route: currentUrl.searchParams.get('route') === 'chat' ? 'chat' : 'other',
      voiceModalOpen: Boolean(ui.voiceModalOpen),
      voiceListening: Boolean(ui.voiceListening),
      voiceState: String(voice.state),
      voiceSessionPresent: Boolean(voice.session),
      voiceErrorPresent: Boolean(voice.errorMessage),
      input: {
        active: Boolean(input.isListening()),
        wantsListening: Boolean(input.wantsListening()),
      },
      ambient: {
        visible: Boolean(
          ambient &&
            ambientRect &&
            ambientRect.width > 0 &&
            ambientRect.height > 0 &&
            ambientStyle?.display !== 'none' &&
            ambientStyle?.visibility !== 'hidden',
        ),
        state: ambient?.getAttribute('data-state') ?? null,
      },
      panel: {
        mounted: Boolean(panel),
        visible: Boolean(
          panel &&
            panelRect &&
            panelRect.width > 0 &&
            panelRect.height > 0 &&
            panelStyle?.display !== 'none' &&
            panelStyle?.visibility !== 'hidden',
        ),
      },
    };
  });
}

async function installTransitionRecorder(page) {
  await page.evaluate(async () => {
    const [uiModule, voiceModule, inputModule] = await Promise.all([
      import('/src/stores/ui.ts'),
      import('/src/features/voice/store.ts'),
      import('/src/features/voice/JarvisVoiceInputService.ts'),
    ]);
    const uiStore = uiModule.useUIStore;
    const voiceStore = voiceModule.useVoiceStore;
    const input = inputModule.JarvisVoiceInputService;
    const timeline = [];
    const record = (kind) => {
      const ui = uiStore.getState();
      const voice = voiceStore.getState();
      timeline.push({
        at: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - window.__vna02Start),
        kind,
        voiceModalOpen: Boolean(ui.voiceModalOpen),
        voiceListening: Boolean(ui.voiceListening),
        voiceState: String(voice.state),
        voiceSessionPresent: Boolean(voice.session),
        inputActive: Boolean(input.isListening()),
        inputWantsListening: Boolean(input.wantsListening()),
      });
    };
    window.__vna02Start = performance.now();
    const offs = [
      uiStore.subscribe((next, previous) => {
        if (next.voiceModalOpen !== previous.voiceModalOpen || next.voiceListening !== previous.voiceListening) {
          record('ui-store');
        }
      }),
      voiceStore.subscribe((next, previous) => {
        if (
          next.state !== previous.state ||
          Boolean(next.session) !== Boolean(previous.session)
        ) {
          record('voice-store');
        }
      }),
    ];
    for (const event of ['voice:start', 'voice:stop', 'voice:error', 'voice:timeout']) {
      offs.push(input.on(event, () => record(event)));
    }
    window.__vna02Lifecycle = { timeline, offs };
    record('instrumentation-ready');
  });
}

async function closedState(page) {
  const state = await snapshot(page);
  return (
    !state.voiceModalOpen &&
    !state.voiceListening &&
    state.voiceState === 'idle' &&
    !state.voiceSessionPresent &&
    !state.input.active &&
    !state.input.wantsListening &&
    !state.panel.visible
  );
}

async function waitForClosed(page, timeoutMs) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (await closedState(page)) return Math.round(performance.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function safeAppCleanup(page) {
  return page.evaluate(async () => {
    const [uiModule, inputModule, routerModule] = await Promise.all([
      import('/src/stores/ui.ts'),
      import('/src/features/voice/JarvisVoiceInputService.ts'),
      import('/src/features/voice/voiceRouter.ts'),
    ]);
    inputModule.JarvisVoiceInputService.cancelListening();
    uiModule.useUIStore.getState().setVoiceModalOpen(false);
    routerModule.handleVoiceModuleClosed();
    return 'app-api-safety-cleanup-invoked';
  });
}

async function main() {
  const config = parseArgs(process.argv);
  const start = performance.now();
  const preflightState = await readWindowsNativeState();
  const preflightIdentity = captureOfficialIdentity(preflightState, identityOptions(config));
  const viteBefore = captureViteIdentity(preflightState);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.port}`, { timeout: 10_000 });
  let page;
  let identityAfterAttach;
  let viteAfterAttach;
  let pageProof;
  try {
    const selected = await selectStableOfficialPage(
      () => browser.contexts().flatMap((context) => context.pages()),
      { timeoutMs: 10_000, intervalMs: 100, stableObservations: 2 },
    );
    page = selected.page;
    const parsedUrl = new URL(page.url());
    if (
      parsedUrl.origin !== config.origin ||
      parsedUrl.pathname !== '/' ||
      parsedUrl.searchParams.get('route') !== config.route
    ) {
      throw new Error('official_chat_route_mismatch');
    }
    const afterAttachState = await readWindowsNativeState();
    identityAfterAttach = captureOfficialIdentity(afterAttachState, identityOptions(config));
    viteAfterAttach = captureViteIdentity(afterAttachState);
    if (
      identityAfterAttach.jarvisPid !== preflightIdentity.jarvisPid ||
      identityAfterAttach.webViewPid !== preflightIdentity.webViewPid ||
      identityAfterAttach.cdpPort !== preflightIdentity.cdpPort ||
      identityAfterAttach.profile.toLowerCase() !== preflightIdentity.profile.toLowerCase() ||
      identityAfterAttach.executablePath.toLowerCase() !== preflightIdentity.executablePath.toLowerCase() ||
      viteAfterAttach.processId !== viteBefore.processId
    ) {
      throw new Error('native_or_vite_identity_changed_during_attach');
    }
    pageProof = await probeOfficialPage(page);
  } catch (error) {
    await browser.close();
    throw error;
  }
  const proof = {
    identityBefore: preflightIdentity,
    identityAfterAttach,
    officialPageProof: pageProof,
    preflightIdentity,
    viteBefore,
    viteAfterAttach,
    officialPageReadyMs: Math.round(performance.now() - start),
    pageRoute: 'chat',
    initial: null,
    ambientWake: { attempted: false, result: 'not-needed', elapsedMs: null },
    click: { attempted: false, result: 'not-attempted', elapsedMs: null },
    panelOpenElapsedMs: null,
    stopInput: { attempted: false, result: 'not-needed', elapsedMs: null },
    close: { attempted: false, result: 'not-attempted', elapsedMs: null },
    closedStateReconciliation: { initialSettled: false, afterCloseSettled: false, fallbackUsed: false },
    port11434RequestsObserved: 0,
    transitions: [],
    final: null,
    errors: [],
  };
  const countForbiddenPortRequest = (request) => {
    try {
      if (new URL(request.url()).port === '11434') proof.port11434RequestsObserved += 1;
    } catch {
      // Unparseable request URLs are not captured as evidence.
    }
  };
  page.on('request', countForbiddenPortRequest);
  try {
    await installTransitionRecorder(page);
    proof.initial = await snapshot(page);
    if (proof.initial.voiceModalOpen || proof.initial.panel.visible) {
      proof.errors.push('voice_panel_already_open; interaction skipped to preserve existing state');
    } else if (proof.initial.input.active || proof.initial.input.wantsListening) {
      proof.errors.push('input_service_active_while_panel_closed; normal open skipped pending safety cleanup');
      await safeAppCleanup(page);
      proof.closedStateReconciliation.afterCloseSettled =
        (await waitForClosed(page, 3_000)) !== null;
      proof.closedStateReconciliation.fallbackUsed = true;
    } else {
      proof.closedStateReconciliation.initialSettled = await waitForClosed(page, 1_500) !== null;
      if (!proof.closedStateReconciliation.initialSettled) {
        proof.errors.push('initial_closed_state_not_reconciled; normal open skipped');
        await safeAppCleanup(page);
        proof.closedStateReconciliation.afterCloseSettled =
          (await waitForClosed(page, 3_000)) !== null;
        proof.closedStateReconciliation.fallbackUsed = true;
      } else {
        const ambient = await page.locator('[data-monochrome-surface="ambient-home"]').count();
        const ambientVisible = ambient > 0 && (await page.locator('[data-monochrome-surface="ambient-home"]').first().isVisible().catch(() => false));
        if (ambientVisible) {
          proof.ambientWake.attempted = true;
          const wakeStarted = performance.now();
          await page.keyboard.press('Shift');
          try {
            await page.waitForFunction(
              () => {
                const element = document.querySelector('[data-monochrome-surface="ambient-home"]');
                if (!element) return true;
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden';
              },
              null,
              { timeout: 3_000 },
            );
            proof.ambientWake.result = 'overlay-hidden-after-harmless-Shift';
          } catch {
            proof.ambientWake.result = 'overlay-remained-visible';
          }
          proof.ambientWake.elapsedMs = Math.round(performance.now() - wakeStarted);
        }

        const ambientStillVisible = await page.locator('[data-monochrome-surface="ambient-home"]').first().isVisible().catch(() => false);
        if (ambientStillVisible) {
          proof.errors.push('ambient_overlay_still_visible; start control not clicked');
        } else {
          const startButton = page.getByRole('button', { name: 'Start Jarvis voice', exact: true });
          const buttonCount = await startButton.count();
          if (buttonCount !== 1 || !(await startButton.isVisible().catch(() => false)) || !(await startButton.isEnabled().catch(() => false))) {
            proof.errors.push(`start_control_not_actionable;count=${buttonCount}`);
          } else {
            proof.click.attempted = true;
            const clickStarted = performance.now();
            await startButton.click({ timeout: 2_500 });
            proof.click.result = 'normal-click-completed';
            proof.click.elapsedMs = Math.round(performance.now() - clickStarted);
            const panelStarted = performance.now();
            try {
              await page.waitForFunction(
                () => {
                  const panel = document.querySelector('#jarvis-panel');
                  if (!panel) return false;
                  const rect = panel.getBoundingClientRect();
                  const style = getComputedStyle(panel);
                  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                },
                null,
                { timeout: 8_000 },
              );
              proof.panelOpenElapsedMs = Math.round(performance.now() - clickStarted);
              proof.click.result = 'panel-visible';
            } catch {
              proof.panelOpenElapsedMs = null;
              proof.click.result = 'normal-click-completed-panel-not-visible-within-8s';
            }
            void panelStarted;
            if (proof.panelOpenElapsedMs !== null) {
              let current = await snapshot(page);
              if (current.input.active || current.input.wantsListening) {
                proof.stopInput.attempted = true;
                const stopName = current.voiceState === 'listening' ? 'Stop listening' : 'Cancel microphone request';
                const stopButton = page.getByRole('button', { name: stopName, exact: true });
                if ((await stopButton.count()) === 1 && (await stopButton.isVisible().catch(() => false))) {
                  const stopStarted = performance.now();
                  await stopButton.click({ timeout: 2_000 });
                  const inactiveAt = await waitForInactive(page, 3_000);
                  proof.stopInput.result = inactiveAt === null ? 'clicked-inactivation-timeout' : 'normal-stop-confirmed';
                  proof.stopInput.elapsedMs = Math.round(performance.now() - stopStarted);
                } else {
                  proof.stopInput.result = 'input-active-stop-control-unavailable';
                }
                current = await snapshot(page);
              }
              const closeButton = page.getByRole('button', { name: 'Close Jarvis voice session', exact: true });
              if ((await closeButton.count()) === 1 && (await closeButton.isVisible().catch(() => false))) {
                proof.close.attempted = true;
                const closeStarted = performance.now();
                await closeButton.click({ timeout: 2_000 });
                const closedElapsed = await waitForClosed(page, 5_000);
                proof.close.elapsedMs = Math.round(performance.now() - closeStarted);
                proof.close.result = closedElapsed === null ? 'normal-close-did-not-reconcile' : 'normal-close-reconciled';
                proof.closedStateReconciliation.afterCloseSettled = closedElapsed !== null;
                if (closedElapsed === null) {
                  await safeAppCleanup(page);
                  proof.closedStateReconciliation.fallbackUsed = true;
                  proof.closedStateReconciliation.afterCloseSettled = (await waitForClosed(page, 3_000)) !== null;
                }
              } else {
                proof.errors.push('close_control_unavailable_after_panel_open');
                await safeAppCleanup(page);
                proof.closedStateReconciliation.fallbackUsed = true;
                proof.closedStateReconciliation.afterCloseSettled = (await waitForClosed(page, 3_000)) !== null;
              }
            }
          }
        }
      }
    }
    proof.final = await snapshot(page);
    proof.transitions = await page.evaluate(() => {
      const value = window.__vna02Lifecycle;
      for (const off of value?.offs ?? []) off();
      return value?.timeline ?? [];
    });
  } catch (error) {
    proof.errors.push(String(error?.message ?? error).slice(0, 220));
    try {
      const state = await snapshot(page);
      if (state.input.active || state.input.wantsListening) {
        await safeAppCleanup(page);
        proof.closedStateReconciliation.fallbackUsed = true;
        proof.closedStateReconciliation.afterCloseSettled = (await waitForClosed(page, 3_000)) !== null;
      }
      proof.final = await snapshot(page);
      proof.transitions = await page.evaluate(() => {
        const value = window.__vna02Lifecycle;
        for (const off of value?.offs ?? []) off();
        return value?.timeline ?? [];
      });
    } catch (cleanupError) {
      proof.errors.push(`safety-check-failed:${String(cleanupError?.message ?? cleanupError).slice(0, 160)}`);
    }
  } finally {
    page.off('request', countForbiddenPortRequest);
    const afterState = await readWindowsNativeState();
    proof.identityAfter = captureOfficialIdentity(afterState, identityOptions(config));
    try {
      proof.viteAfter = captureViteIdentity(afterState);
    } catch (error) {
      proof.errors.push(String(error?.message ?? error).slice(0, 220));
      proof.viteAfter = null;
    }
    proof.totalElapsedMs = Math.round(performance.now() - start);
    proof.control = 'official Instance 2 Tauri WebView; attached CDP only; browser connection disconnected; app process left running';
    await browser.close();
  }

  const executableHash = sha256(await readFile(config.executablePath));
  const source = [];
  for (const relativePath of SOURCE_FILES) {
    const fullPath = path.join(REPO, relativePath);
    source.push({
      path: relativePath,
      sha256: sha256(await readFile(fullPath)),
      cleanAtCapture: execFileSync('git', ['status', '--porcelain', '--', relativePath], { cwd: REPO, encoding: 'utf8' }).trim().length === 0,
    });
  }
  const identity = {
    capturedAt: new Date().toISOString(),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO, encoding: 'utf8' }).trim(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
    upstream: execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: REPO, encoding: 'utf8' }).trim(),
    identityBefore: proof.identityBefore,
    identityAfter: proof.identityAfter,
    executableSha256: executableHash,
    viteProcessId: 32892,
    viteRendererOrigin: config.origin,
    source,
  };
  await writeFile(path.join(OUT, 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
  await writeFile(path.join(OUT, 'acceptance.json'), `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ identity, acceptance: proof }, null, 2)}\n`);
  if (proof.final?.input?.active || proof.final?.input?.wantsListening) process.exitCode = 2;
}

async function waitForInactive(page, timeoutMs) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const state = await snapshot(page);
    if (!state.input.active && !state.input.wantsListening) return Math.round(performance.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

main().catch((error) => {
  process.stderr.write(`VNA02_DRIVER_FAILED: ${String(error?.message ?? error).slice(0, 240)}\n`);
  process.exitCode = 1;
});
