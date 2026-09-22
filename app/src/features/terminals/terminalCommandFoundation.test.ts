import { describe, expect, it } from 'vitest';
import {
  consumeOneTurnTerminalContext,
  createTerminalContextSession,
  createVibespaceSlashCapture,
  formatTerminalCliResponse,
  parseTerminalLocalIpcRequest,
  type TerminalPromptEvidence,
} from './terminalCommandFoundation';

const verifiedPrompt: TerminalPromptEvidence = {
  promptProtocol: 'osc133',
  atPrompt: true,
  alternateScreen: false,
  interactiveProgram: false,
  localShell: true,
  passwordPrompt: false,
  sshSession: false,
};

describe('VibeSpace terminal command foundation', () => {
  it('opens the slash palette without forwarding command bytes to a verified local shell', () => {
    const capture = createVibespaceSlashCapture();
    let forwarded = '';

    for (const data of [...'/vibespace', '\r']) {
      const result = capture.push(data, verifiedPrompt);
      forwarded += result.forwardData;
      if (data === '\r') {
        expect(result).toEqual({
          forwardData: '',
          openPalette: true,
          heldText: '',
        });
      }
    }

    expect(forwarded).toBe('');
  });

  it.each([
    ['unverified prompt', { ...verifiedPrompt, promptProtocol: 'none' as const }],
    ['alternate screen', { ...verifiedPrompt, alternateScreen: true }],
    ['interactive program', { ...verifiedPrompt, interactiveProgram: true }],
    ['remote shell', { ...verifiedPrompt, sshSession: true }],
    ['password prompt', { ...verifiedPrompt, passwordPrompt: true }],
    ['non-local shell', { ...verifiedPrompt, localShell: false }],
  ])('forwards slash input unchanged in a %s', (_label, evidence) => {
    const capture = createVibespaceSlashCapture();

    expect(capture.push('/', evidence)).toEqual({
      forwardData: '/',
      openPalette: false,
      heldText: '',
    });
  });

  it('flushes a non-command prefix exactly and never treats pasted text as the overlay trigger', () => {
    const capture = createVibespaceSlashCapture();

    expect(capture.push('/', verifiedPrompt).forwardData).toBe('');
    expect(capture.push('v', verifiedPrompt).forwardData).toBe('');
    expect(capture.push('a', verifiedPrompt)).toEqual({
      forwardData: '/va',
      openPalette: false,
      heldText: '',
    });
    expect(capture.push('/vibespace\r', verifiedPrompt)).toEqual({
      forwardData: '/vibespace\r',
      openPalette: false,
      heldText: '',
    });
    const largePaste = 'x'.repeat(100_000);
    expect(capture.push(largePaste, verifiedPrompt).forwardData).toBe(largePaste);
  });

  it('fails closed without invoking accessors in prompt evidence', () => {
    let getterCalls = 0;
    const evidence = {
      get promptProtocol() {
        getterCalls += 1;
        return 'osc133';
      },
      atPrompt: true,
      alternateScreen: false,
      interactiveProgram: false,
      localShell: true,
      passwordPrompt: false,
      sshSession: false,
    } as TerminalPromptEvidence;

    expect(createVibespaceSlashCapture().push('/', evidence).forwardData).toBe('/');
    expect(getterCalls).toBe(0);
  });

  it('validates and freezes a bounded per-pane Context session', () => {
    const session = createTerminalContextSession({
      version: 1,
      terminalSessionId: 'pty-1',
      paneId: 'pane-1',
      projectId: 'project-1',
      activeMapIds: ['map-1'],
      pinnedEntityIds: ['entity-1'],
      activeSkillIds: ['build'],
      agentSlug: 'builder',
      mode: 'one_turn',
      updatedAt: 1,
      contextRevision: 2,
    });

    expect(session).toMatchObject({
      terminalSessionId: 'pty-1',
      projectId: 'project-1',
      mode: 'one_turn',
      contextRevision: 2,
    });
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.activeMapIds)).toBe(true);
    expect(() =>
      createTerminalContextSession({
        ...session,
        activeMapIds: ['map-1', 'map-1'],
      }),
    ).toThrow(/terminal context session/i);
  });

  it('returns one-turn pins once and clears them without changing persistent maps or skills', () => {
    const session = createTerminalContextSession({
      version: 1,
      terminalSessionId: 'pty-1',
      paneId: null,
      projectId: 'project-1',
      activeMapIds: ['map-1'],
      pinnedEntityIds: ['entity-1', 'entity-2'],
      activeSkillIds: ['build'],
      agentSlug: null,
      mode: 'one_turn',
      updatedAt: 1,
      contextRevision: 2,
    });

    const consumed = consumeOneTurnTerminalContext(session, 3);

    expect(consumed.entityIds).toEqual(['entity-1', 'entity-2']);
    expect(consumed.next).toMatchObject({
      activeMapIds: ['map-1'],
      activeSkillIds: ['build'],
      pinnedEntityIds: [],
      mode: 'persistent',
      updatedAt: 3,
      contextRevision: 3,
    });
  });

  it('accepts only closed versioned authenticated-local-IPC request envelopes', () => {
    const request = parseTerminalLocalIpcRequest({
      protocolVersion: 1,
      requestId: 'request-1',
      nonce: 'a'.repeat(64),
      method: 'context.list',
      params: {},
    });

    expect(request).toEqual({
      protocolVersion: 1,
      requestId: 'request-1',
      nonce: 'a'.repeat(64),
      method: 'context.list',
      params: {},
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(() =>
      parseTerminalLocalIpcRequest({
        ...request,
        method: 'filesystem.delete',
      }),
    ).toThrow(/local IPC request/i);
    let getterCalls = 0;
    expect(() =>
      parseTerminalLocalIpcRequest({
        protocolVersion: 1,
        requestId: 'request-1',
        nonce: 'a'.repeat(64),
        method: 'context.list',
        get params() {
          getterCalls += 1;
          return {};
        },
      }),
    ).toThrow(/local IPC request/i);
    expect(getterCalls).toBe(0);
  });

  it('formats transcript-safe human and JSON CLI failures without control sequences', () => {
    const response = {
      requestId: 'request-1',
      ok: false as const,
      code: 'app_not_running' as const,
      message: 'VibeSpace is not running.',
    };

    expect(formatTerminalCliResponse(response, { json: false, color: false })).toBe(
      'VibeSpace is not running.',
    );
    expect(JSON.parse(formatTerminalCliResponse(response, { json: true, color: false }))).toEqual(
      response,
    );
    expect(() =>
      formatTerminalCliResponse(
        { ...response, message: 'unsafe\u001b[31m' },
        { json: false, color: false },
      ),
    ).toThrow(/CLI response/i);
    expect(() =>
      formatTerminalCliResponse({ ...response, ok: true }, { json: false, color: false }),
    ).toThrow(/CLI response/i);
  });
});

it('drops invalid historical pane-role labels without weakening context identity validation', async () => {
  const { normalizeTerminalContextAgentSlug } = await import('./terminalCommandFoundation');
  expect(normalizeTerminalContextAgentSlug('claude')).toBe('claude');
  expect(normalizeTerminalContextAgentSlug('reviewer-2')).toBe('reviewer-2');
  expect(normalizeTerminalContextAgentSlug('claude 2')).toBeNull();
  expect(normalizeTerminalContextAgentSlug('')).toBeNull();
  expect(normalizeTerminalContextAgentSlug(undefined)).toBeNull();
  expect(normalizeTerminalContextAgentSlug({ toString: () => 'claude' })).toBeNull();
  const base = {
    version: 1,
    terminalSessionId: 'terminal-2',
    paneId: 'pane-2',
    projectId: 'project-a',
    activeMapIds: [],
    pinnedEntityIds: [],
    activeSkillIds: [],
    mode: 'persistent',
    updatedAt: 1,
    contextRevision: 0,
  };
  expect(() => createTerminalContextSession({ ...base, agentSlug: 'claude 2' })).toThrow(
    'Invalid terminal context session',
  );
  expect(
    createTerminalContextSession({
      ...base,
      agentSlug: normalizeTerminalContextAgentSlug('claude 2'),
    }).agentSlug,
  ).toBeNull();
});
