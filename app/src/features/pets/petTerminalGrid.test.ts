/**
 * Terminal grid layout + ownership: real presentation store, no PTY clones.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadPetTerminalViewMode,
  savePetTerminalViewMode,
  terminalTileReceivesInput,
  PET_TERMINAL_VIEW_MODE_KEY,
} from './petTerminalLayout';
import {
  createEmptyPresentationState,
  moveTerminalPresentation,
  petPanelTerminalCount,
} from './petPresentation';
import { PET_PANEL_MAX_TERMINALS, PET_PANEL_TERMINAL_LIMIT_MESSAGE } from './petPanelLifecycle';

describe('pet terminal grid layout helpers', () => {
  it('migrates the retired Grid preference to the single-terminal tabs view', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
    };
    expect(loadPetTerminalViewMode(storage)).toBe('tabs');
    savePetTerminalViewMode('tabs', storage);
    expect(mem.get(PET_TERMINAL_VIEW_MODE_KEY)).toBe('tabs');
    expect(loadPetTerminalViewMode(storage)).toBe('tabs');
    mem.set(PET_TERMINAL_VIEW_MODE_KEY, 'grid');
    expect(loadPetTerminalViewMode(storage)).toBe('tabs');
  });

  it('only focused tile receives input', () => {
    expect(terminalTileReceivesInput('a', 'a')).toBe(true);
    expect(terminalTileReceivesInput('b', 'a')).toBe(false);
    expect(terminalTileReceivesInput('a', null)).toBe(false);
  });
});

describe('pet terminal grid presentation ownership (no PTY clone)', () => {
  let state = createEmptyPresentationState();

  beforeEach(() => {
    state = createEmptyPresentationState();
  });

  function seedMain(id: string) {
    state = {
      ...state,
      terminals: {
        ...state.terminals,
        [id]: {
          terminalId: id,
          ptyId: id,
          owner: 'main',
          title: id,
          cwd: `C:\\work\\${id}`,
          shell: 'pwsh',
          status: 'running',
        },
      },
    };
  }

  it('moves 1–4 terminals to pet panel preserving same pty ids', () => {
    for (let i = 1; i <= 4; i += 1) seedMain(`t${i}`);
    for (let i = 1; i <= 4; i += 1) {
      const r = moveTerminalPresentation(state, `t${i}`, 'pet-mini-panel');
      expect(r.ok).toBe(true);
      if (r.ok) state = r.state;
    }
    expect(petPanelTerminalCount(state)).toBe(4);
    for (let i = 1; i <= 4; i += 1) {
      const t = state.terminals[`t${i}`];
      expect(t.ptyId).toBe(`t${i}`);
      expect(t.owner).toBe('pet-mini-panel');
      expect(t.terminalId).toBe(`t${i}`);
    }
  });

  it('tab selection preserves terminal and pty ids (ownership only)', () => {
    seedMain('pty-live');
    const moved = moveTerminalPresentation(state, 'pty-live', 'pet-mini-panel');
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    state = moved.state;
    // View preference normalization does not touch presentation rows.
    const before = { ...state.terminals['pty-live'] };
    savePetTerminalViewMode('tabs');
    expect(state.terminals['pty-live']).toEqual(before);
    expect(state.terminals['pty-live'].ptyId).toBe('pty-live');
  });

  it('fifth terminal keeps exact limit message and stays off panel', () => {
    for (let i = 1; i <= 4; i += 1) seedMain(`t${i}`);
    for (let i = 1; i <= 4; i += 1) {
      const r = moveTerminalPresentation(state, `t${i}`, 'pet-mini-panel');
      if (r.ok) state = r.state;
    }
    seedMain('t5');
    const fail = moveTerminalPresentation(state, 't5', 'pet-mini-panel');
    expect(fail.ok).toBe(false);
    if (!fail.ok) {
      expect(fail.message).toBe(PET_PANEL_TERMINAL_LIMIT_MESSAGE);
    }
    expect(state.terminals.t5?.owner).toBe('main');
    expect(petPanelTerminalCount(state)).toBe(PET_PANEL_MAX_TERMINALS);
  });
});
