import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RESOURCE_PAYLOAD_CHARS,
  insertResourceText,
  normalizeResourceReference,
  quoteResourcePath,
  resolveResourceDestination,
  routeResourceInteraction,
  type ResourceReference,
} from './resourceInteraction';

const fileReference: ResourceReference = {
  kind: 'file',
  name: 'demo file.txt',
  path: 'C:\\project files\\demo file.txt',
};

describe('resource interaction security and routing', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('accepts bounded local references and rejects controls or oversized payloads', () => {
    expect(normalizeResourceReference(fileReference)).toEqual(fileReference);
    expect(normalizeResourceReference({ ...fileReference, path: 'C:\\bad\npath.txt' })).toBeNull();
    expect(normalizeResourceReference({
      kind: 'context',
      name: 'Context',
      raw: JSON.stringify({ title: 'Context', summary: 'safe' }),
      path: 'C:\\repo\\context_map.json',
    })).toEqual({
      kind: 'context',
      name: 'Context',
      raw: JSON.stringify({ title: 'Context', summary: 'safe' }),
      path: 'C:\\repo\\context_map.json',
    });
    expect(normalizeResourceReference({
      kind: 'context',
      name: 'Context',
      raw: 'x'.repeat(MAX_RESOURCE_PAYLOAD_CHARS + 1),
    })).toBeNull();
  });

  it('quotes paths for PowerShell, cmd, POSIX shells, and an unknown conservative fallback', () => {
    expect(quoteResourcePath("C:\\Users\\O'Brien\\demo file.txt", 'powershell')).toBe(
      "'C:\\Users\\O''Brien\\demo file.txt'",
    );
    expect(quoteResourcePath('C:\\Program Files\\demo.txt', 'cmd')).toBe(
      '"C:\\Program Files\\demo.txt"',
    );
    expect(quoteResourcePath("/tmp/O'Brien/demo file.txt", 'posix')).toBe(
      "'/tmp/O'\"'\"'Brien/demo file.txt'",
    );
    expect(quoteResourcePath('/tmp/demo file.txt', 'unknown')).toBe("'/tmp/demo file.txt'");
    expect(quoteResourcePath('bad\r\npath', 'posix')).toBeNull();
  });

  it('resolves exact chat and terminal destinations from existing drop surfaces', () => {
    const chat = document.createElement('div');
    chat.dataset.terminalDrop = 'chat';
    chat.dataset.terminalDropChatId = 'chat-123';
    const chatChild = document.createElement('span');
    chat.appendChild(chatChild);
    document.body.appendChild(chat);

    expect(resolveResourceDestination(chatChild)).toEqual({ kind: 'chat', chatId: 'chat-123' });

    const pane = document.createElement('div');
    pane.dataset.terminalDrop = 'pane';
    pane.dataset.terminalDropPaneId = 'pane-7';
    pane.dataset.resourceShell = 'pwsh.exe';
    document.body.appendChild(pane);

    expect(resolveResourceDestination(pane)).toEqual({
      kind: 'terminal',
      paneId: 'pane-7',
      shell: 'powershell',
    });
  });

  it('rejects password, credential-like, disabled, readonly, and disconnected text targets', () => {
    const cases: HTMLElement[] = [];

    const password = document.createElement('input');
    password.type = 'password';
    cases.push(password);

    const token = document.createElement('textarea');
    token.id = 'provider-api-token';
    cases.push(token);

    const labelledSecret = document.createElement('input');
    labelledSecret.id = 'secret-field';
    const label = document.createElement('label');
    label.htmlFor = labelledSecret.id;
    label.textContent = 'Credential value';
    document.body.append(label, labelledSecret);
    cases.push(labelledSecret);

    const disabled = document.createElement('textarea');
    disabled.disabled = true;
    cases.push(disabled);

    const readonly = document.createElement('input');
    readonly.readOnly = true;
    cases.push(readonly);

    for (const target of cases) {
      if (!target.isConnected) document.body.appendChild(target);
      expect(resolveResourceDestination(target)).toBeNull();
    }

    const disconnected = document.createElement('textarea');
    expect(resolveResourceDestination(disconnected)).toBeNull();
  });

  it('inserts at the current selection and dispatches a bubbling input event', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'before after';
    textarea.setSelectionRange(7, 12);
    document.body.appendChild(textarea);
    const onInput = vi.fn();
    textarea.addEventListener('input', onInput);

    expect(insertResourceText(textarea, 'middle')).toBe(true);
    expect(textarea.value).toBe('before middle');
    expect(textarea.selectionStart).toBe(13);
    expect(textarea.selectionEnd).toBe(13);
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it('routes chat attachments and terminal insertion without submitting either destination', () => {
    const chat = document.createElement('div');
    chat.dataset.resourceDrop = 'chat';
    chat.dataset.resourceChatId = 'chat-shared';
    document.body.appendChild(chat);
    const attached = vi.fn();
    window.addEventListener('jarvis:composer:attach-resource', attached);

    expect(routeResourceInteraction(fileReference, chat)).toBe(true);
    expect(attached).toHaveBeenCalledTimes(1);
    expect((attached.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      chatId: 'chat-shared',
      resource: fileReference,
    });

    const pane = document.createElement('div');
    pane.dataset.resourceDrop = 'terminal';
    pane.dataset.resourcePaneId = 'pane-2';
    pane.dataset.resourceShell = 'bash';
    document.body.appendChild(pane);
    const written = vi.fn();
    window.addEventListener('jarvis:terminal:write-text', written);

    expect(routeResourceInteraction(fileReference, pane)).toBe(true);
    expect(written).toHaveBeenCalledTimes(1);
    expect((written.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      paneId: 'pane-2',
      text: "'C:\\project files\\demo file.txt'",
    });
    expect((written.mock.calls[0]?.[0] as CustomEvent).detail.text).not.toMatch(/[\r\n]/);

    window.removeEventListener('jarvis:composer:attach-resource', attached);
    window.removeEventListener('jarvis:terminal:write-text', written);
  });
});
