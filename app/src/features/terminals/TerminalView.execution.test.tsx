import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ITheme } from 'xterm';

import {
  attachTerminalViewExecution,
  awaitTerminalFontReadiness,
  awaitTerminalOutputReadiness,
  canonicalTerminalSpawnToken,
  createTerminalExitLatch,
  createTerminalOutputLatch,
  finalizeTerminalRendererTeardown,
  formatTerminalVoiceFailure,
  observeTerminalDocumentTheme,
  settleTerminalInitializationFailure,
  terminalSmokeFailureCode,
} from './TerminalView';

describe('TerminalView canonical execution truth', () => {
  it('wires initial and live xterm presentation through the canonical resolver', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/terminals/TerminalView.tsx'),
      'utf8',
    );

    expect(source).toMatch(
      /import\s*\{[\s\S]*?applyTerminalTheme,[\s\S]*?resolveTerminalDocumentTheme,[\s\S]*?resolveTerminalTheme,[\s\S]*?\}\s*from '\.\/terminalTheme';/u,
    );
    expect(source).toContain('theme: currentTerminalTheme()');
    expect(source).toContain('style={{ backgroundColor: currentTerminalTheme().background }}');
    expect(source).toContain(
      'mutationObserver = observeTerminalDocumentTheme(currentTerm, containerEl, null);',
    );
    expect(source).not.toContain('const LIGHT_THEME');
    expect(source).not.toContain("t === 'light'");
  });

  it('behaviorally follows document theme mutations in xterm and its container without an override', async () => {
    const previousTheme = document.documentElement.getAttribute('data-theme');
    const target: { options: { theme?: ITheme; cursorBlink?: boolean } } = { options: {} };
    const container = document.createElement('div');
    document.documentElement.setAttribute('data-theme', 'dark');

    const observer = observeTerminalDocumentTheme(target, container, null);
    try {
      expect(target.options.theme?.background).toBe('#2a2018');
      expect(container.style.backgroundColor).toBe('rgb(42, 32, 24)');
      expect(target.options.cursorBlink).toBe(true);

      document.documentElement.setAttribute('data-theme', 'monochrome');

      await vi.waitFor(() => {
        expect(target.options.theme?.background).toBe('#0b0d10');
        expect(container.style.backgroundColor).toBe('rgb(11, 13, 16)');
        expect(target.options.cursorBlink).toBe(false);
      });
    } finally {
      observer.disconnect();
      if (previousTheme == null) {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', previousTheme);
      }
    }
  });

  it('disables terminal cursor motion when reduced motion is requested', () => {
    const previousTheme = document.documentElement.getAttribute('data-theme');
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    document.documentElement.setAttribute('data-theme', 'dark');
    const target: { options: { theme?: ITheme; cursorBlink?: boolean } } = { options: {} };
    const observer = observeTerminalDocumentTheme(target, document.createElement('div'), null);

    try {
      expect(target.options.cursorBlink).toBe(false);
    } finally {
      observer.disconnect();
      vi.unstubAllGlobals();
      if (previousTheme == null) {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', previousTheme);
      }
    }
  });

  it('formats terminal dictation startup failure without exposing thrown details', () => {
    const message = formatTerminalVoiceFailure('startup');

    expect(message).toBe(
      'The action failed, sir. Action: Terminal dictation startup. ' +
        'Cause: Speech-to-text could not start in the terminal. ' +
        'Check microphone access, then try again.',
    );
    expect(message).not.toContain('synthetic terminal microphone detail');
  });

  it('formats terminal speech-recognition unavailability through the same shared boundary', () => {
    expect(formatTerminalVoiceFailure('unsupported')).toBe(
      'The action failed, sir. Action: Terminal speech recognition availability. ' +
        'Cause: Speech-to-text is not available in this runtime.',
    );
  });

  it('routes the terminal dictation startup catch through the closed formatter', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/terminals/TerminalView.tsx'),
      'utf8',
    );
    const start = source.indexOf('const onGlobalSttToggle = (event: Event) => {');
    const end = source.indexOf('window.addEventListener(COMPOSER_STT_TOGGLE_EVENT', start);
    const startupBlock = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(startupBlock).toContain(
      "toast.warning('Voice unsupported', formatTerminalVoiceFailure('unsupported'));",
    );
    expect(startupBlock).toContain(
      "toast.error('Voice error', formatTerminalVoiceFailure('startup'));",
    );
    expect(startupBlock).toContain('setDictating(false);');
    expect(startupBlock).toContain('} catch {');
    expect(startupBlock).not.toMatch(/catch\s*\(\s*(?:err|error)\b/i);
    expect(startupBlock).not.toContain('.message');
  });

  it('latches early output for the exact spawned session and exposes shell readiness', async () => {
    const delivered = vi.fn();
    const latch = createTerminalOutputLatch(delivered);

    for (let index = 0; index < 40; index += 1) {
      latch.observe({ sessionId: 'tty_other', data: `unrelated output ${index}` });
    }
    latch.observe({ sessionId: 'tty_exact', data: 'PS> ' });

    expect(delivered).not.toHaveBeenCalled();
    expect(latch.bind('tty_exact')).toBe(true);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveBeenCalledWith({ sessionId: 'tty_exact', data: 'PS> ' });
    await expect(latch.readiness).resolves.toBe(true);

    latch.observe({ sessionId: 'tty_other', data: 'still unrelated' });
    latch.observe({ sessionId: 'tty_exact', data: 'ready' });
    expect(delivered).toHaveBeenCalledTimes(2);
  });

  it('bounds shell-output readiness when a native shell has not emitted a prompt', async () => {
    vi.useFakeTimers();
    try {
      const latch = createTerminalOutputLatch(vi.fn());
      expect(latch.bind('tty_quiet')).toBe(false);
      const readiness = awaitTerminalOutputReadiness(latch.readiness, 25);

      await vi.advanceTimersByTimeAsync(25);

      await expect(readiness).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds font readiness so terminal initialization cannot hang', async () => {
    vi.useFakeTimers();
    try {
      const neverReady = new Promise<unknown>(() => undefined);
      const readiness = awaitTerminalFontReadiness(neverReady, 25);

      await vi.advanceTimersByTimeAsync(25);

      await expect(readiness).resolves.toBe(false);
      await expect(awaitTerminalFontReadiness(Promise.resolve(), 25)).resolves.toBe(true);
      await expect(awaitTerminalFontReadiness(undefined, 25)).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gates the terminal execution evidence selector behind the smoke contract', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/terminals/TerminalView.tsx'),
      'utf8',
    );

    expect(source).toContain(
      'KERNEL_SMOKE_ENABLED && executionId ? SIK_EVIDENCE.terminalExecution : undefined',
    );
    expect(source).not.toContain(
      'KERNEL_SMOKE_ENABLED ? SIK_EVIDENCE.terminalExecution : undefined',
    );
    expect(source).not.toContain('data-sik-evidence="terminal.execution"');
    expect(source).toContain('data-initialization-phase={');
    expect(source).toContain('data-terminal-status={');
    expect(source).toContain("setInitializationPhase('kernel_terminal_phase_native_spawn')");
  });

  it('publishes a spawned session before releasing a latched early exit', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/terminals/TerminalView.tsx'),
      'utf8',
    );
    const binding = source.slice(
      source.indexOf('sid = result.sessionId;'),
      source.indexOf('sessionCwd = result.cwd || cwd || null;'),
    );

    expect(binding.indexOf('setActiveSessionId(sid);')).toBeGreaterThan(0);
    expect(binding.indexOf('setActiveSessionId(sid);')).toBeLessThan(
      binding.indexOf("setInitializationPhase('kernel_terminal_phase_session_bound')"),
    );
    expect(binding.indexOf('setActiveSessionId(sid);')).toBeLessThan(
      binding.indexOf('exitLatch.bind(processAttachment)'),
    );
  });

  it('maps terminal initialization failures to bounded smoke-safe codes', () => {
    expect(terminalSmokeFailureCode(null)).toBeUndefined();
    expect(
      terminalSmokeFailureCode('TypeError: canonical_terminal_handle_unavailable_after_restart'),
    ).toBe('kernel_terminal_authority_unavailable');
    expect(terminalSmokeFailureCode('terminal: spawn failed: private native detail')).toBe(
      'kernel_terminal_native_spawn_failed',
    );
    expect(terminalSmokeFailureCode('unclassified detail that must not escape')).toBe(
      'kernel_terminal_initialization_failed',
    );
  });

  it('refuses to spawn a canonical terminal after restart without its private token owner', () => {
    const readToken = vi.fn(() => undefined);

    expect(() =>
      canonicalTerminalSpawnToken('jterm_restart', {
        isCanonical: () => true,
        readToken,
      }),
    ).toThrow('canonical_terminal_handle_unavailable_after_restart');
    expect(readToken).toHaveBeenCalledWith('jterm_restart');
  });

  it('keeps manual terminal spawns tokenless without consulting canonical storage', () => {
    const readToken = vi.fn(() => 'unexpected');

    expect(
      canonicalTerminalSpawnToken('manual_terminal', {
        isCanonical: () => false,
        readToken,
      }),
    ).toBeUndefined();
    expect(readToken).not.toHaveBeenCalled();
  });

  it('settles spawn rejection through the bound degraded-result owner', async () => {
    const failBeforeNativeExit = vi.fn(async () => true);
    const killManual = vi.fn(async () => undefined);

    await settleTerminalInitializationFailure(
      {
        executionId: 'jterm_1',
        sessionId: '',
        nativeSessionStarted: false,
        executionAttached: false,
      },
      {
        isCanonical: () => true,
        failBeforeNativeExit,
        requestCancellation: vi.fn(),
        killManual,
      },
    );

    expect(failBeforeNativeExit).toHaveBeenCalledWith('jterm_1', 'native_spawn_failed');
    expect(killManual).not.toHaveBeenCalled();
  });

  it('settles attach failure and manually stops the unbound native session', async () => {
    const failBeforeNativeExit = vi.fn(async () => true);
    const killManual = vi.fn(async () => undefined);

    await settleTerminalInitializationFailure(
      {
        executionId: 'jterm_1',
        sessionId: 'pty_unbound',
        nativeSessionStarted: true,
        executionAttached: false,
      },
      {
        isCanonical: () => true,
        failBeforeNativeExit,
        requestCancellation: vi.fn(),
        killManual,
      },
    );

    expect(failBeforeNativeExit).toHaveBeenCalledWith('jterm_1', 'native_attach_failed');
    expect(killManual).toHaveBeenCalledWith('pty_unbound');
  });

  it('attaches the exact canonical session before releasing an early native exit', async () => {
    const order: string[] = [];
    const attachment = {
      accountId: 'account-a',
      projectId: 'project-a',
      paneId: 'pane-a',
      sessionId: 'pty_early',
      processInstanceId: 'process-instance-1',
      pid: 4242,
      processStartedAt: 1_723_456_789_000,
      runtimeGeneration: 'runtime-generation-1',
    } as const;
    const payload = {
      ...attachment,
      code: 0,
      reason: 'natural_exit' as const,
    };
    const latch = createTerminalExitLatch((exit) => {
      order.push(`exit:${exit.sessionId}`);
    });
    const attach = vi.fn(async () => {
      order.push('attach');
      return true;
    });

    latch.observe(payload);
    await expect(
      attachTerminalViewExecution('jterm_1', attachment, {
        attach,
      }),
    ).resolves.toBe(true);
    expect(latch.bind(attachment)).toBe(true);

    expect(attach).toHaveBeenCalledWith('jterm_1', {
      accountId: 'account-a',
      projectId: 'project-a',
      paneId: 'pane-a',
      sessionId: 'pty_early',
      processInstanceId: 'process-instance-1',
      pid: 4242,
      processStartedAt: 1_723_456_789_000,
      runtimeGeneration: 'runtime-generation-1',
    });
    expect(order).toEqual(['attach', 'exit:pty_early']);
  });

  it('passes a legacy execution through the real native attachment call site', async () => {
    const attachment = {
      accountId: 'account-a',
      projectId: 'project-a',
      paneId: 'pane-a',
      sessionId: 'pty-legacy',
      processInstanceId: 'process-legacy',
      pid: 4242,
      processStartedAt: 1_723_456_789_000,
      runtimeGeneration: 'runtime-generation-1',
    } as const;
    const attach = vi.fn(async () => true);

    await expect(
      attachTerminalViewExecution('legacy-execution', attachment, {
        attach,
      }),
    ).resolves.toBe(true);

    expect(attach).toHaveBeenCalledExactlyOnceWith('legacy-execution', attachment);
  });

  it('attaches the full spawn or fresh-list process binding before publishing readiness', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/terminals/TerminalView.tsx'),
      'utf8',
    );

    expect(source).toContain('processInstanceId: string;');
    expect(source).toContain('runtimeGeneration: string;');
    expect(source).toContain('const backendInfo = restoreDecision.backendInfo;');
    const ready = source.indexOf('onReadyRef.current?.(sid)');
    const spawnAttach = source.indexOf(
      'const attached = await attachTerminalViewExecution(executionId, processAttachment);',
    );
    const restoreAttach = source.indexOf(
      'const attached = await attachTerminalViewExecution(executionId, processAttachment);',
      spawnAttach + 1,
    );
    expect(spawnAttach).toBeGreaterThan(0);
    expect(restoreAttach).toBeGreaterThan(spawnAttach);
    expect(spawnAttach).toBeLessThan(ready);
    expect(restoreAttach).toBeLessThan(ready);
  });

  it('delivers only the first exact native exit after binding a session', () => {
    const delivered = vi.fn();
    const latch = createTerminalExitLatch(delivered);
    const attachment = {
      accountId: 'account-a',
      projectId: 'project-a',
      paneId: 'pane-a',
      sessionId: 'pty_exact',
      processInstanceId: 'process-exact',
      pid: 4242,
      processStartedAt: 1_723_456_789_000,
      runtimeGeneration: 'runtime-exact',
    } as const;

    latch.observe({
      ...attachment,
      processInstanceId: 'process-stale',
      code: 1,
      reason: 'natural_exit',
    });
    expect(latch.bind(attachment)).toBe(false);
    latch.observe({ ...attachment, code: 0, reason: 'natural_exit' });
    latch.observe({ ...attachment, code: 1, reason: 'natural_exit' });

    expect(delivered).toHaveBeenCalledOnce();
    expect(delivered).toHaveBeenCalledWith({
      ...attachment,
      code: 0,
      reason: 'natural_exit',
    });
  });

  it('wires exact prompt evidence through fail-closed slash capture before PTY persistence/write', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/terminals/TerminalView.tsx'),
      'utf8',
    );
    const outputStart = source.indexOf('const outputLatch = createTerminalOutputLatch');
    const outputEnd = source.indexOf('const exitLatch = createTerminalExitLatch', outputStart);
    const outputBlock = source.slice(outputStart, outputEnd);
    expect(outputBlock).toContain('slashIntegration.observeOutput(payload.data)');

    const inputStart = source.indexOf('term.onData((data: string) => {');
    const inputEnd = source.indexOf('// Subscribe BEFORE spawning', inputStart);
    const inputBlock = source.slice(inputStart, inputEnd);
    expect(inputBlock.indexOf('slashIntegration.pushInput')).toBeGreaterThan(0);
    expect(inputBlock.indexOf('slashIntegration.pushInput')).toBeLessThan(
      inputBlock.indexOf('inputTracker.push(forwardData)'),
    );
    expect(inputBlock).toContain('if (capture.openPalette)');
    expect(inputBlock).toContain("invoke('terminal_write', { sessionId: sid, data: forwardData })");
    expect(inputBlock).not.toContain("invoke('terminal_write', { sessionId: sid, data })");
    expect(source).toContain('<TerminalCommandPalette');
    expect(source).toContain('installTerminalShellIntegration,');
    expect(source).toContain('uninstallTerminalShellIntegration,');
    expect(source).toContain('onInstallCli={installTerminalCli}');
    expect(source).toContain('onUninstallCli={uninstallTerminalCli}');
    expect(source).toContain('onInstallShellIntegration={installTerminalShellIntegration}');
    expect(source).toContain('onUninstallShellIntegration={uninstallTerminalShellIntegration}');
  });

  it('propagates trusted terminal scope to child CLI processes', () => {
    const frontend = readFileSync(
      resolve(process.cwd(), 'src/features/terminals/TerminalView.tsx'),
      'utf8',
    );
    const backend = readFileSync(resolve(process.cwd(), 'src-tauri/src/terminal.rs'), 'utf8');
    const sessionCreation = backend.indexOf('let session_id = format!("tty_{}"');
    const childSpawn = backend.indexOf('.spawn_command(builder)');

    expect(frontend).toContain('VIBESPACE_PANE_ID');
    expect(backend).toContain('builder.env("VIBESPACE_TERMINAL_SESSION_ID", &session_id);');
    expect(backend).toContain('builder.env("VIBESPACE_PROJECT_ID", project_id);');
    expect(sessionCreation).toBeGreaterThan(0);
    expect(childSpawn).toBeGreaterThan(sessionCreation);
  });

  it('revalidates canonical ownership synchronously before native spawn', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/terminals/TerminalView.tsx'),
      'utf8',
    );
    const authorize = source.indexOf('authorizeCanonicalTerminalSpawn(executionId');
    const spawnStatement = source.indexOf('const result = await', authorize);
    const spawn = source.indexOf("invoke<SpawnResult>('terminal_spawn'", spawnStatement);
    expect(authorize).toBeGreaterThan(0);
    expect(spawn).toBeGreaterThan(authorize);
    expect(source.slice(authorize, spawnStatement)).not.toContain('await ');
    expect(source.slice(authorize, spawn)).toContain(
      "throw new TypeError('canonical_terminal_scope_revoked_before_spawn')",
    );
  });

  it('restores an exact live screen once without spawning, writing to the PTY, or appending replay', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/terminals/TerminalView.tsx'),
      'utf8',
    );
    expect(source).toContain('readTerminalScreenSnapshot({');
    expect(source).toContain('readActiveScreenSnapshot:');
    expect(source).toContain('captureTerminalScreenSnapshot(');

    const attachStart = source.indexOf(
      '} else {',
      source.indexOf("if (restoreDecision.kind === 'spawn')"),
    );
    const attachEnd = source.indexOf('      } catch (err) {', attachStart);
    const attachBlock = source.slice(attachStart, attachEnd);
    expect(attachBlock.match(/term\.write\(restoreDecision\.restoredText/gu)).toHaveLength(1);
    expect(attachBlock).not.toContain("invoke('terminal_spawn'");
    expect(attachBlock).not.toContain("invoke('terminal_write'");
    expect(attachBlock).not.toContain('.appendOutput(');
  });

  it('waits for the final accepted xterm write before capturing and disposing the old renderer', async () => {
    const order: string[] = [];
    let renderedScreen = 'PS C:\\repo> ';
    let releaseWrite: (() => void) | undefined;
    let drained = false;
    const capture = vi.fn(() => {
      order.push('capture');
      expect(renderedScreen.match(/FINAL_MARKER/gu)).toHaveLength(1);
    });
    const appendTranscript = vi.fn((text: string) => {
      order.push('append');
      expect(text).toBe('FINAL_MARKER');
    });
    const dispose = vi.fn(() => order.push('dispose'));

    const finalizer = finalizeTerminalRendererTeardown({
      terminal: {
        write(data, callback) {
          order.push('write');
          releaseWrite = () => {
            renderedScreen += data;
            callback();
          };
        },
      },
      pendingWrite: Promise.resolve(),
      drainAcceptedOutput: () => {
        if (drained) return null;
        drained = true;
        return { displayData: 'FINAL_MARKER', transcriptData: 'FINAL_MARKER' };
      },
      appendTranscript,
      identityIsCurrent: () => true,
      captureSnapshot: capture,
      dispose,
    });

    await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));
    expect(capture).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    releaseWrite?.();
    await finalizer;

    expect(appendTranscript).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(order).toEqual(['write', 'append', 'capture', 'dispose']);
  });

  it('does not let a delayed old-renderer finalizer overwrite a later identity owner', async () => {
    let releaseWrite: (() => void) | undefined;
    let identityIsCurrent = true;
    let drained = false;
    const capture = vi.fn();
    const dispose = vi.fn();

    const finalizer = finalizeTerminalRendererTeardown({
      terminal: {
        write(_data, callback) {
          releaseWrite = callback;
        },
      },
      pendingWrite: Promise.resolve(),
      drainAcceptedOutput: () => {
        if (drained) return null;
        drained = true;
        return { displayData: 'OLD_FINAL', transcriptData: 'OLD_FINAL' };
      },
      appendTranscript: vi.fn(),
      identityIsCurrent: () => identityIsCurrent,
      captureSnapshot: capture,
      dispose,
    });

    await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));
    identityIsCurrent = false;
    releaseWrite?.();
    await finalizer;

    expect(capture).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('settles teardown without an unhandled rejection when snapshot and disposal fail', async () => {
    await expect(
      finalizeTerminalRendererTeardown({
        terminal: { write: vi.fn() },
        pendingWrite: Promise.resolve(),
        drainAcceptedOutput: () => null,
        appendTranscript: vi.fn(),
        identityIsCurrent: () => true,
        captureSnapshot: () => {
          throw new Error('private snapshot failure');
        },
        dispose: () => {
          throw new Error('private disposal failure');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps preserve-existing capacity native and writes ordered setup commands in sequence', () => {
    const frontend = readFileSync(
      resolve(process.cwd(), 'src/features/terminals/TerminalView.tsx'),
      'utf8',
    );
    const backend = readFileSync(resolve(process.cwd(), 'src-tauri/src/terminal.rs'), 'utf8');

    expect(frontend).toContain('preserveExisting: preserveExisting || undefined');
    expect(frontend).toContain('for (const startupWrite of orderedStartupCommands)');
    expect(frontend).toContain('data: commandToInput(startupWrite)');
    expect(backend).toContain('preserve_existing: Option<bool>');
    expect(backend).toContain(
      'terminal: project capacity reached; existing terminals were preserved',
    );
  });

  it('regenerates the managed briefing and Context pack from supervised session changes', () => {
    const frontend = readFileSync(
      resolve(process.cwd(), 'src/features/terminals/TerminalView.tsx'),
      'utf8',
    );

    expect(frontend).toContain('subscribeTerminalContextSessions');
    expect(frontend).toContain('terminalContextSession: session');
    expect(frontend).toContain('session.terminalSessionId !== activeSessionId');
    expect(frontend).toContain('contextDeliveryQueueRef');
    expect(frontend).toContain('getOrCreateTerminalContextSession');
    expect(frontend).toContain('initialSession.contextRevision === 0');
    expect(frontend).toContain('updateTerminalContextSession');
  });
});
