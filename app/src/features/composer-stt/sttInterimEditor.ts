export type SttFieldSnapshot = {
  before: string;
  after: string;
  caretStart: number;
  /** Original selection is required to make cancellation lossless. */
  selected?: string;
};

export function separatorForBefore(before: string): string {
  return before.length > 0 && !/\s$/.test(before) ? ' ' : '';
}

export function captureSttFieldSnapshot(
  el: HTMLInputElement | HTMLTextAreaElement,
): SttFieldSnapshot {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  return {
    before: el.value.slice(0, start),
    after: el.value.slice(end),
    caretStart: start,
    selected: el.value.slice(start, end),
  };
}

export function captureSttTextSnapshot(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): SttFieldSnapshot {
  return {
    before: value.slice(0, selectionStart),
    after: value.slice(selectionEnd),
    caretStart: selectionStart,
    selected: value.slice(selectionStart, selectionEnd),
  };
}

export function buildSttPreviewValue(snapshot: SttFieldSnapshot, partial: string): string {
  const preview = partial.trim();
  if (!preview) return restoreSttFieldValue(snapshot);
  const sep = separatorForBefore(snapshot.before);
  const tail = /^[\p{L}\p{N}]/u.test(snapshot.after) ? ' ' : '';
  return snapshot.before + sep + preview + tail + snapshot.after;
}

export function buildSttCommittedValue(
  snapshot: SttFieldSnapshot,
  finalText: string,
): string | null {
  const trimmed = finalText.trim();
  if (!trimmed) return null;
  const sep = separatorForBefore(snapshot.before);
  const tail = /^[\p{L}\p{N}]/u.test(snapshot.after) ? ' ' : '';
  return snapshot.before + sep + trimmed + tail + snapshot.after;
}

export function previewSttInField(
  el: HTMLInputElement | HTMLTextAreaElement,
  snapshot: SttFieldSnapshot,
  partial: string,
): void {
  el.value = buildSttPreviewValue(snapshot, partial);
  const caret = buildSttPreviewValue(snapshot, partial).length - snapshot.after.length;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function commitSttInField(
  el: HTMLInputElement | HTMLTextAreaElement,
  snapshot: SttFieldSnapshot,
  finalText: string,
): boolean {
  const next = buildSttCommittedValue(snapshot, finalText);
  if (!next) {
    revertSttPreview(el, snapshot);
    return false;
  }
  el.value = next;
  const caret = next.length - snapshot.after.length;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

export function revertSttPreview(
  el: HTMLInputElement | HTMLTextAreaElement,
  snapshot: SttFieldSnapshot,
): void {
  el.value = restoreSttFieldValue(snapshot);
  el.setSelectionRange(snapshot.caretStart, snapshot.caretStart + (snapshot.selected?.length ?? 0));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function restoreSttFieldValue(snapshot: SttFieldSnapshot): string {
  return snapshot.before + (snapshot.selected ?? '') + snapshot.after;
}
