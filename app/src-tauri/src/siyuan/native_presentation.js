(() => {
  if (window.__vibespaceNativePresentation) return;
  window.__vibespaceNativePresentation = true;
  const metadata = /^<!-- vibespace-context-map:v1 map=[A-Za-z0-9_-]+ payload=[A-Za-z0-9_-]+ -->$/u;
  const implementation =
    'VibeSpace-managed SiYuan map root. Native child documents are the searchable graph nodes.';
  const generated = /^Files: [\d,]+ · Bytes: [\d,]+ · Generated: \d+$/u;
  let scheduled = false;
  const refresh = () => {
    scheduled = false;
    // Keep the durable metadata intact; only its paragraph in the managed root
    // is hidden. Other documents and ordinary comments remain visible.
    for (const title of document.querySelectorAll('.protyle-title[data-node-id]')) {
      if (title.dataset.nodeId !== targetDocumentId) continue;
      for (const block of title
        .closest('.protyle')
        ?.querySelectorAll('[data-type="NodeParagraph"]') ?? []) {
        const text = block.querySelector('[contenteditable="true"]')?.textContent?.trim() ?? '';
        block.classList.toggle(
          'vibespace-managed-metadata',
          metadata.test(text) || text === implementation || generated.test(text),
        );
      }
    }
    const notifications = window.siyuan?.config?.appearance?.notifications;
    if (notifications) notifications.browserCompatibility = false;
    const compatibility = window.siyuan?.languages?.useChrome;
    if (compatibility) {
      for (const notice of document.querySelectorAll('.b3-snackbar__content')) {
        const text = notice.textContent?.trim() ?? '';
        if (
          text === compatibility ||
          (text.startsWith(compatibility + ' v') &&
            /^\d+(?:\.\d+)+$/u.test(text.slice(compatibility.length + 2)))
        ) {
          notice
            .closest('.b3-snackbar')
            ?.querySelector('.b3-snackbar__close')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
      }
    }
  };
  const start = () => {
    const style = document.createElement('style');
    style.textContent = '.protyle .vibespace-managed-metadata { display: none !important; }';
    document.head.append(style);
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(refresh);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    refresh();
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
