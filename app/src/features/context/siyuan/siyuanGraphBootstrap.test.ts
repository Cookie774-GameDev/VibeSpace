import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const documentId = '20261005111111-abcdefg';
const notebookId = '20261005111112-abcdefg';
const testModuleUrl = import.meta.url;
const source = readFileSync(
  new URL('../../../../src-tauri/src/siyuan/surface.rs', testModuleUrl),
  'utf8',
);
const template =
  /const SIYUAN_GRAPH_FIRST_INITIALIZATION_SCRIPT_TEMPLATE: &str = r#"([\s\S]*?)"#;/u.exec(
    source,
  )![1]!;

describe('production SiYuan graph bootstrap with pinned DOM contracts', () => {
  let acknowledgement: ReturnType<typeof setInterval>;
  const reports: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    reports.length = 0;
    delete (window as unknown as Record<string, unknown>).__vibespaceGraphBootstrapNonce;
    document.title = 'SiYuan';
    document.body.innerHTML = `<button class="dock__item" data-type="file"></button><button class="dock__item" data-type="graph"></button>`;
    document
      .querySelector('[data-type="file"]')!
      .addEventListener('click', (event) =>
        (event.currentTarget as HTMLElement).classList.add('dock__item--active'),
      );
    document.querySelector('[data-type="graph"]')!.addEventListener('click', (event) => {
      (event.currentTarget as HTMLElement).classList.add('dock__item--active');
      const graph = document.createElement('div');
      graph.className = 'sy__graph';
      graph.innerHTML = '<button data-type="fullscreen"></button>';
      graph.firstElementChild!.addEventListener('click', () => graph.classList.add('fullscreen'));
      document.body.append(graph);
    });
    acknowledgement = setInterval(() => {
      if (document.title.startsWith('__VIBESPACE_SIYUAN_GRAPH__')) {
        reports.push(document.title);
        document.title = 'SiYuan';
      }
    }, 25);
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    clearInterval(acknowledgement);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  function openTree() {
    const tree = document.createElement('ul');
    tree.dataset.url = notebookId;
    tree.innerHTML = `<li data-type="navigation-root"><span class="b3-list-item__toggle"><svg class="b3-list-item__arrow b3-list-item__arrow--open"></svg></span></li><li data-node-id="${documentId}"><span class="b3-list-item__text">Map</span></li>`;
    tree.querySelector('.b3-list-item__text')!.addEventListener('click', () => {
      const protyle = document.createElement('div');
      protyle.className = 'protyle';
      protyle.innerHTML = `<div class="protyle-title" data-node-id="${documentId}"></div>`;
      document.body.append(protyle);
    });
    document.body.append(tree);
  }
  function run() {
    const script = template
      .replace('__MANAGED_PRESENTATION__', '')
      .replace('__TARGET_DOCUMENT_ID__', JSON.stringify(documentId))
      .replace('__TARGET_NOTEBOOK_ID__', JSON.stringify(notebookId))
      .replace('__GRAPH_MODE__', '"local"')
      .replace('__REPORT_NONCE__', '"fixture"')
      .replace('__EXPECTED_ORIGIN__', JSON.stringify(window.location.origin));
    new Function(script)();
  }
  const target = {
    code: 0,
    data: { box: notebookId, rootID: documentId, path: `/${documentId}.sy` },
  };
  it('opens only the verified closed notebook before navigating to its map', async () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<li data-url="${notebookId}"><span data-type="open" data-url="${notebookId}"></span></li><li data-url="20261005111113-abcdefg"><span data-type="open"></span></li>`,
    );
    const open = vi.fn(openTree);
    document
      .querySelector(`[data-type="open"][data-url="${notebookId}"]`)!
      .addEventListener('click', open);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => target })),
    );
    run();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(open).toHaveBeenCalledTimes(1);
    expect(reports.some((report) => report.endsWith(':ready:'))).toBe(true);
  });
  it('retries temporary indexing but rejects a foreign notebook without opening anything', async () => {
    openTree();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 3 }) })
      .mockResolvedValue({ ok: true, json: async () => target });
    vi.stubGlobal('fetch', fetch);
    run();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(reports.some((report) => report.endsWith(':ready:'))).toBe(true);
  });
  it('retains actionable failure for an invalid target and keeps the notebook closed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ...target, data: { ...target.data, box: 'foreign' } }),
      })),
    );
    run();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      reports.some((report) => report.endsWith(':failed:siyuan_graph_target_unavailable')),
    ).toBe(true);
    expect(document.querySelector('.sy__graph')).toBeNull();
  });
});
