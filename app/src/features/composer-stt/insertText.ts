let lastGlobalSttEditable: HTMLElement | null = null;
let lastComposerSttTextarea: HTMLTextAreaElement | null = null;

/** True when the focused element is a chat composer textarea (not agent prompts, etc.). */
export function isComposerSttTextarea(el: Element | null): el is HTMLTextAreaElement {
  return (
    el instanceof HTMLElement &&
    el.getAttribute('aria-label') === 'Message' &&
    (el instanceof HTMLTextAreaElement ||
      (el.dataset.inlineChatEditor === 'true' &&
        typeof (el as HTMLTextAreaElement).setSelectionRange === 'function'))
  );
}

/** Remember the last STT-eligible field so toolbar mic clicks still target it after focus moves. */
export function rememberSttEditableFromFocus(target: EventTarget | null): void {
  if (!(target instanceof HTMLElement)) return;
  if (isComposerSttTextarea(target)) {
    lastComposerSttTextarea = target;
    lastGlobalSttEditable = null;
    return;
  }
  if (isGlobalSttEditable(target)) {
    lastGlobalSttEditable = target;
    lastComposerSttTextarea = null;
  }
}

/** Capture pointer/context targets (e.g. right-click) as the active dictation field. */
export function noteSttEditableFromPointer(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const editable = target.closest(
    'textarea, input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input:not([type]), [contenteditable="true"]',
  );
  if (!editable) return;
  if (isComposerSttTextarea(editable)) {
    lastComposerSttTextarea = editable;
    lastGlobalSttEditable = null;
    return;
  }
  if (editable instanceof HTMLElement && isGlobalSttEditable(editable)) {
    lastGlobalSttEditable = editable;
    lastComposerSttTextarea = null;
  }
}

export function mountSttFocusTracking(): () => void {
  const onFocusIn = (event: FocusEvent) => rememberSttEditableFromFocus(event.target);
  document.addEventListener('focusin', onFocusIn, true);
  return () => document.removeEventListener('focusin', onFocusIn, true);
}

export function resolveGlobalSttEditable(preferred?: Element | null): HTMLElement | null {
  const active = preferred ?? document.activeElement;
  if (isGlobalSttEditable(active)) return active;
  if (lastGlobalSttEditable && document.contains(lastGlobalSttEditable)) {
    return lastGlobalSttEditable;
  }
  return null;
}

export function resolveComposerSttTextarea(preferred?: Element | null): HTMLTextAreaElement | null {
  const active = preferred ?? document.activeElement;
  if (isComposerSttTextarea(active)) return active;
  if (lastComposerSttTextarea && document.contains(lastComposerSttTextarea)) {
    return lastComposerSttTextarea;
  }
  return null;
}

/** @internal test helper */
export function resetSttFocusMemoryForTests(): void {
  lastGlobalSttEditable = null;
  lastComposerSttTextarea = null;
}

/** True when focus is inside an xterm.js surface (handled by TerminalView). */
export function isTerminalSttSurface(el: Element | null): boolean {
  return Boolean(el?.closest('.xterm'));
}

export function isGlobalSttEditable(
  el: Element | null,
): el is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (isTerminalSttSurface(el) || isComposerSttTextarea(el)) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el instanceof HTMLInputElement) {
    const type = (el.type || 'text').toLowerCase();
    return (
      type === 'text' ||
      type === 'search' ||
      type === 'email' ||
      type === 'url' ||
      type === 'tel' ||
      type === ''
    );
  }
  return el.isContentEditable;
}

/** Insert transcribed speech at the caret in a known editable field. */
export function insertTextIntoEditable(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
  text: string,
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const before = el.value.slice(0, start);
    const sep = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const next = before + sep + trimmed + el.value.slice(end);
    el.value = next;
    const cursor = (before + sep + trimmed).length;
    el.setSelectionRange(cursor, cursor);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  if (el.isContentEditable) {
    el.focus();
    document.execCommand('insertText', false, trimmed);
    return true;
  }

  return false;
}

/** Insert transcribed speech at the caret in the currently focused editable. */
export function insertTextIntoFocusedEditable(text: string): boolean {
  const el = document.activeElement;
  if (!isGlobalSttEditable(el)) return false;
  return insertTextIntoEditable(el, text);
}
