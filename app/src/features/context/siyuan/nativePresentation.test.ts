import { afterEach, expect, it, vi } from 'vitest';
import script from '../../../../src-tauri/src/siyuan/native_presentation.js?raw';

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  delete (window as any).__vibespaceNativePresentation;
  delete (window as any).siyuan;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('hides only exact managed metadata and dismisses only the upstream compatibility notice', async () => {
  const marker = '<!-- vibespace-context-map:v1 map=map-test payload=eyJ9 -->';
  const root = (id: string, text: string) =>
    `<div class="protyle"><div class="protyle-title" data-node-id="${id}"></div><div data-type="NodeParagraph" data-node-index="0"><div contenteditable="true">${text.replaceAll('<', '&lt;')}</div></div></div>`;
  document.body.innerHTML =
    root('root', marker) + root('other', marker) + root('root', 'Ordinary text');
  const notifications = { browserCompatibility: true, workspaceNotSSD: true };
  (window as any).siyuan = {
    config: { appearance: { notifications } },
    languages: { useChrome: 'Chrome notice' },
  };
  const notices = ['Chrome notice v3.8.1', 'Real connection failure'];
  for (const text of notices) {
    const notice = document.createElement('div');
    notice.className = 'b3-snackbar';
    notice.innerHTML = `<div class="b3-snackbar__content">${text}</div><button class="b3-snackbar__close"></button>`;
    notice.querySelector('button')!.addEventListener('click', () => notice.remove());
    document.body.append(notice);
  }
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  new Function('targetDocumentId', script)('root');
  expect(document.querySelectorAll('.vibespace-managed-metadata')).toHaveLength(1);
  expect(document.querySelector('.vibespace-managed-metadata')?.textContent).toBe(marker);
  expect(document.querySelectorAll('.b3-snackbar')).toHaveLength(1);
  expect(document.querySelector('.b3-snackbar')?.textContent).toBe('Real connection failure');
  expect(notifications).toEqual({ browserCompatibility: false, workspaceNotSSD: true });
  document.querySelector('.vibespace-managed-metadata [contenteditable]')!.textContent =
    'Now ordinary text';
  await vi.waitFor(() =>
    expect(document.querySelectorAll('.vibespace-managed-metadata')).toHaveLength(0),
  );
});

it('hides generated implementation paragraphs only in the managed map root', () => {
  const implementation =
    'VibeSpace-managed SiYuan map root. Native child documents are the searchable graph nodes.';
  const generated = 'Files: 58 · Bytes: 27135481 · Generated: 1788932815202';
  const root = (id: string) =>
    `<div class="protyle"><div class="protyle-title" data-node-id="${id}"></div>${[implementation, generated, 'SiYuan indexed 58 files across 61 allowed source items.'].map((text, index) => `<div data-type="NodeParagraph" data-node-index="${index + 1}"><div contenteditable="true">${text}</div></div>`).join('')}</div>`;
  document.body.innerHTML = root('root') + root('other');
  new Function('targetDocumentId', script)('root');
  expect(document.querySelectorAll('.vibespace-managed-metadata')).toHaveLength(2);
  expect(
    document.querySelectorAll('.protyle')[1]?.querySelector('.vibespace-managed-metadata'),
  ).toBeNull();
  expect(document.body.textContent).toContain(implementation);
  expect(document.querySelectorAll('.vibespace-managed-metadata')[1]?.textContent).toBe(generated);
});
