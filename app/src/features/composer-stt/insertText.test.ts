import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  insertTextIntoFocusedEditable,
  isComposerSttTextarea,
  isGlobalSttEditable,
  isTerminalSttSurface,
  rememberSttEditableFromFocus,
  resetSttFocusMemoryForTests,
  resolveComposerSttTextarea,
  resolveGlobalSttEditable,
} from './insertText';

describe('insertText', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    resetSttFocusMemoryForTests();
  });

  it('keeps the atomic reference editor in composer dictation routing', () => {
    const editor = document.createElement('div');
    editor.setAttribute('aria-label', 'Message');
    editor.dataset.inlineChatEditor = 'true';
    container.append(editor);
    expect(isComposerSttTextarea(editor)).toBe(false);
    Object.defineProperty(editor, 'setSelectionRange', { value: () => {} });
    expect(isComposerSttTextarea(editor)).toBe(true);
    expect(isGlobalSttEditable(editor)).toBe(false);
    rememberSttEditableFromFocus(editor);
    expect(resolveComposerSttTextarea()).toBe(editor);
  });
  it('detects composer vs generic textareas', () => {
    const composer = document.createElement('textarea');
    composer.setAttribute('aria-label', 'Message');
    const agent = document.createElement('textarea');
    agent.id = 'agent-prompt';

    expect(isComposerSttTextarea(composer)).toBe(true);
    expect(isComposerSttTextarea(agent)).toBe(false);
    expect(isGlobalSttEditable(agent)).toBe(true);
    expect(isGlobalSttEditable(composer)).toBe(false);
  });

  it('skips xterm surfaces', () => {
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const helper = document.createElement('textarea');
    xterm.appendChild(helper);
    container.appendChild(xterm);
    helper.focus();

    expect(isTerminalSttSurface(helper)).toBe(true);
    expect(isGlobalSttEditable(helper)).toBe(false);
  });

  it('inserts speech at the caret in a generic textarea', () => {
    const field = document.createElement('textarea');
    field.value = 'Hello';
    field.selectionStart = 5;
    field.selectionEnd = 5;
    container.appendChild(field);
    field.focus();

    expect(insertTextIntoFocusedEditable('world')).toBe(true);
    expect(field.value).toBe('Hello world');
    expect(field.selectionStart).toBe(11);
  });

  it('resolves the last focused global field when the mic button steals focus', () => {
    const field = document.createElement('textarea');
    field.id = 'agent-prompt';
    container.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    const micButton = document.createElement('button');
    micButton.textContent = 'Mic';
    container.appendChild(micButton);
    micButton.focus();

    expect(document.activeElement).toBe(micButton);
    expect(resolveGlobalSttEditable()).toBe(field);
  });

  it('resolves the last focused composer textarea when focus moves to a button', () => {
    const composer = document.createElement('textarea');
    composer.setAttribute('aria-label', 'Message');
    container.appendChild(composer);
    composer.focus();
    rememberSttEditableFromFocus(composer);

    const micButton = document.createElement('button');
    container.appendChild(micButton);
    micButton.focus();

    expect(resolveComposerSttTextarea()).toBe(composer);
    expect(resolveGlobalSttEditable()).toBeNull();
  });

  it('clears stale composer memory after focusing a global text field', () => {
    const composer = document.createElement('textarea');
    composer.setAttribute('aria-label', 'Message');
    const agent = document.createElement('textarea');
    agent.id = 'agent-prompt';
    container.append(composer, agent);

    composer.focus();
    rememberSttEditableFromFocus(composer);
    agent.focus();
    rememberSttEditableFromFocus(agent);

    expect(resolveComposerSttTextarea()).toBeNull();
    expect(resolveGlobalSttEditable()).toBe(agent);
  });
});
