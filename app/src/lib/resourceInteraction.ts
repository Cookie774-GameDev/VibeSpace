export const MAX_RESOURCE_PAYLOAD_CHARS = 8_192;

const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/;
const SAFE_DESTINATION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SENSITIVE_FIELD_RE = /(?:password|passcode|pin|api[-_ ]?key|token|secret|credential|auth|payment|card|cvv|cvc)/i;

export type ResourceReference =
  | { kind: 'file'; name: string; path: string }
  | { kind: 'context'; name: string; raw: string; path?: string };

export type ResourceShellFamily = 'powershell' | 'cmd' | 'posix' | 'unknown';

export type ResourceDestination =
  | { kind: 'chat'; chatId: string }
  | { kind: 'terminal'; paneId: string; shell: ResourceShellFamily }
  | { kind: 'text'; element: HTMLInputElement | HTMLTextAreaElement | HTMLElement };

function isBoundedSafeText(value: unknown, allowEmpty = false): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) return false;
  return value.length <= MAX_RESOURCE_PAYLOAD_CHARS && !CONTROL_CHARACTER_RE.test(value);
}

export function isSafeResourceInsertText(value: unknown): value is string {
  return isBoundedSafeText(value);
}

function cleanName(value: string): string | null {
  const name = value.trim();
  return name && name.length <= 256 && !CONTROL_CHARACTER_RE.test(name) ? name : null;
}

export function normalizeResourceReference(value: ResourceReference): ResourceReference | null {
  if (!value || (value.kind !== 'file' && value.kind !== 'context')) return null;
  const name = cleanName(value.name);
  if (!name) return null;

  if (value.kind === 'file') {
    if (!isBoundedSafeText(value.path)) return null;
    return { kind: 'file', name, path: value.path.trim() };
  }

  if (!isBoundedSafeText(value.raw)) return null;
  if (value.path !== undefined && !isBoundedSafeText(value.path)) return null;
  return {
    kind: 'context',
    name,
    raw: value.raw,
    ...(value.path === undefined ? {} : { path: value.path.trim() }),
  };
}

export function classifyResourceShell(command?: string | null): ResourceShellFamily {
  const executable = (command ?? '').trim().toLowerCase().split(/[\\/]/).pop()?.split(/\s+/)[0] ?? '';
  if (/^(?:powershell|powershell\.exe|pwsh|pwsh\.exe)$/.test(executable)) return 'powershell';
  if (/^(?:cmd|cmd\.exe)$/.test(executable)) return 'cmd';
  if (/^(?:bash|zsh|sh|dash|fish|ksh|wsl|wsl\.exe)$/.test(executable)) return 'posix';
  return 'unknown';
}

export function quoteResourcePath(
  path: string,
  shell: ResourceShellFamily,
): string | null {
  if (!isBoundedSafeText(path)) return null;
  const clean = path.trim();
  if (shell === 'powershell') return `'${clean.replace(/'/g, "''")}'`;
  if (shell === 'cmd') {
    const escaped = clean.replace(/%/g, '%%').replace(/"/g, '^"');
    return `"${escaped}"`;
  }
  return `'${clean.replace(/'/g, `'"'"'`)}'`;
}

function safeDestinationId(value: string | undefined): string | null {
  const id = value?.trim() ?? '';
  return SAFE_DESTINATION_ID_RE.test(id) ? id : null;
}

function associatedLabelText(element: HTMLInputElement | HTMLTextAreaElement): string {
  return Array.from(element.labels ?? []).map((label) => label.textContent ?? '').join(' ');
}

function sensitiveFieldMetadata(element: HTMLElement): string {
  const input = element as HTMLInputElement;
  return [
    element.id,
    input.name,
    input.autocomplete,
    element.getAttribute('aria-label'),
    element.getAttribute('placeholder'),
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? associatedLabelText(element)
      : '',
  ].filter(Boolean).join(' ');
}

function resolveEditableElement(
  target: Element,
): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  const candidate = target.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]');
  if (!(candidate instanceof HTMLElement) || !candidate.isConnected) return null;

  if (candidate instanceof HTMLInputElement) {
    if (candidate.disabled || candidate.readOnly || candidate.type === 'password') return null;
    if (!/^(?:text|search|url|email|tel)$/i.test(candidate.type)) return null;
  } else if (candidate instanceof HTMLTextAreaElement) {
    if (candidate.disabled || candidate.readOnly) return null;
  } else if (candidate.getAttribute('aria-disabled') === 'true') {
    return null;
  }

  if (SENSITIVE_FIELD_RE.test(sensitiveFieldMetadata(candidate))) return null;
  return candidate;
}

export function resolveResourceDestination(target: EventTarget | null): ResourceDestination | null {
  if (!(target instanceof Element) || !target.isConnected) return null;

  const surface = target.closest('[data-resource-drop], [data-terminal-drop]') as HTMLElement | null;
  if (surface) {
    const kind = surface.dataset.resourceDrop ?? surface.dataset.terminalDrop;
    if (kind === 'chat') {
      const chatId = safeDestinationId(
        surface.dataset.resourceChatId ?? surface.dataset.terminalDropChatId,
      );
      return chatId ? { kind: 'chat', chatId } : null;
    }
    if (kind === 'terminal' || kind === 'pane') {
      const paneId = safeDestinationId(
        surface.dataset.resourcePaneId ?? surface.dataset.terminalDropPaneId,
      );
      return paneId
        ? {
            kind: 'terminal',
            paneId,
            shell: classifyResourceShell(surface.dataset.resourceShell),
          }
        : null;
    }
  }

  const element = resolveEditableElement(target);
  return element ? { kind: 'text', element } : null;
}

export function insertResourceText(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
  text: string,
): boolean {
  if (!isBoundedSafeText(text)) return false;
  if (!element.isConnected || !resolveEditableElement(element)) return false;

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    element.setRangeText(text, start, end, 'end');
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }));
    return true;
  }

  const selection = window.getSelection();
  if (!selection) return false;
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !element.contains(range.commonAncestorContainer)) {
    element.focus();
    const fallback = document.createRange();
    fallback.selectNodeContents(element);
    fallback.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(fallback);
  }
  const activeRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!activeRange) return false;
  activeRange.deleteContents();
  const node = document.createTextNode(text);
  activeRange.insertNode(node);
  activeRange.setStartAfter(node);
  activeRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(activeRange);
  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: 'insertText',
    data: text,
  }));
  return true;
}

export function resourceReferenceText(resource: ResourceReference): string {
  if (resource.kind === 'file') return resource.path;
  return resource.path ?? `[Context: ${resource.name}]`;
}

export function attachResourceToChat(value: ResourceReference, chatId: string): boolean {
  const resource = normalizeResourceReference(value);
  const safeChatId = safeDestinationId(chatId);
  if (!resource || !safeChatId) return false;
  window.dispatchEvent(new CustomEvent('jarvis:composer:attach-resource', {
    detail: { chatId: safeChatId, resource },
  }));
  return true;
}

export function routeResourceInteraction(
  value: ResourceReference,
  target: EventTarget | null,
): boolean {
  const resource = normalizeResourceReference(value);
  const destination = resolveResourceDestination(target);
  if (!resource || !destination) return false;

  if (destination.kind === 'chat') {
    return attachResourceToChat(resource, destination.chatId);
  }

  const text = resourceReferenceText(resource);
  if (destination.kind === 'terminal') {
    const quoted = quoteResourcePath(text, destination.shell);
    if (!quoted) return false;
    window.dispatchEvent(new CustomEvent('jarvis:terminal:write-text', {
      detail: { paneId: destination.paneId, text: quoted },
    }));
    return true;
  }

  return insertResourceText(destination.element, text);
}
